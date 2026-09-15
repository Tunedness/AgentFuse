/**
 * A minimal OTLP/HTTP receiver, for seeing what AgentFuse exports.
 *
 * Point a policy at it:
 *
 *     telemetry:
 *       enabled: true
 *       otlp_endpoint: http://127.0.0.1:4318
 *
 * and run it:
 *
 *     node examples/otlp-receiver.mjs
 *
 * Node only, no dependencies. It is a development aid, not a collector: a real
 * deployment points `otlp_endpoint` at an OpenTelemetry Collector, a vendor
 * endpoint, or the Tunedness Control Plane, all of which speak the same
 * protocol. This is here so you can answer "is anything coming out, and what is
 * in it" without installing one.
 *
 * ## What arrives
 *
 * Two paths, both `POST` with `content-type: application/json`:
 *
 * - `/v1/traces` — one `mcp.tools/call` span per forwarded tool call. It is a
 *   child of the agent's span when the request carried a `traceparent` in its
 *   `_meta` (SEP-414), and the root of its own trace otherwise. AgentFuse never
 *   invents a `traceparent`, so a root span here means nothing upstream was
 *   tracing.
 * - `/v1/logs` — the four `tunedness.*` events, as log records carrying an
 *   `eventName`: `tunedness.tool_call`, `tunedness.policy_decision`,
 *   `tunedness.budget_event`, `tunedness.loop_detection`. There is no fifth,
 *   and there is no `security_event` — that one belongs to McpGuard.
 *
 * Attributes are `tunedness.*` throughout, and anything estimated says so in
 * its name (`tunedness.call.tokens_estimated`), because the proxy meters tool
 * I/O and never sees the model's own tokens.
 *
 * Answer `200` with anything; AgentFuse does not read the body. Answer slowly,
 * or not at all, and it drops the batch, backs off and carries on — telemetry
 * is never allowed to cost a tool call.
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT ?? '4318');

/**
 * Flattens an OTLP payload into the records inside it.
 *
 * The nesting is always the same three levels: a resource, the instrumentation
 * scope, and then the spans or log records themselves.
 *
 * @param {unknown} body parsed request body
 * @returns {{ resource: object, records: object[] }}
 */
export function flatten(body) {
  const outer = body?.resourceSpans ?? body?.resourceLogs ?? [];
  const records = [];
  let resource = {};
  for (const entry of outer) {
    resource = entry.resource ?? resource;
    for (const scope of entry.scopeSpans ?? entry.scopeLogs ?? []) {
      records.push(...(scope.spans ?? scope.logRecords ?? []));
    }
  }
  return { resource, records };
}

/**
 * An OTLP attribute list as a plain object.
 *
 * Values are tagged by type — `stringValue`, `intValue` (a *string*, because
 * these are int64 on the wire), `doubleValue`, `boolValue`, `arrayValue` — and
 * this keeps whichever one is there.
 *
 * @param {Array<{ key: string, value: object }> | undefined} attributes
 * @returns {Record<string, unknown>}
 */
export function readAttributes(attributes) {
  const out = {};
  for (const entry of attributes ?? []) {
    const [value] = Object.values(entry.value ?? {});
    out[entry.key] = Array.isArray(value?.values)
      ? value.values.map((item) => Object.values(item)[0])
      : value;
  }
  return out;
}

/**
 * One line per record, which is all a development aid owes you.
 *
 * @param {string} path the URL the export arrived on
 * @param {unknown} body parsed request body
 * @returns {string[]}
 */
export function describe(path, body) {
  const { records } = flatten(body);
  return records.map((record) => {
    const attributes = readAttributes(record.attributes);
    const label = record.eventName ?? record.name ?? path;
    const session = attributes['tunedness.session_id'] ?? '-';
    const rest = Object.entries(attributes)
      .filter(([key]) => key !== 'tunedness.session_id' && key !== 'event.name')
      .map(([key, value]) => `${key.replace('tunedness.', '')}=${JSON.stringify(value)}`)
      .join(' ');
    return `${label} session=${session} ${rest}`.trimEnd();
  });
}

/**
 * Starts the receiver.
 *
 * @param {number} port
 */
export function listen(port = PORT) {
  return createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // A receiver has the same reason to cap a body as AgentFuse does.
      if (size > 8_000_000) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end('{"error":"POST only"}');
        return;
      }
      try {
        for (const line of describe(req.url ?? '', JSON.parse(Buffer.concat(chunks).toString()))) {
          process.stdout.write(`${line}\n`);
        }
      } catch {
        process.stdout.write(`${req.url}: unparseable body\n`);
      }
      // Anything at all: AgentFuse reads the status and ignores the body.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  }).listen(port, '127.0.0.1', () => {
    process.stdout.write(`listening on http://127.0.0.1:${port} (/v1/traces, /v1/logs)\n`);
  });
}

// Only when run directly, so a test can import the readers without starting a
// server — and so this file stays checkable rather than merely readable.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  listen();
}
