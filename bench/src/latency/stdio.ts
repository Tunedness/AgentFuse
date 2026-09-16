/**
 * Tier 2 — end to end, over a real pipe, through the real CLI.
 *
 * ```
 * (a) direct   bench ⇄ stdio ⇄ noop-server.mjs
 * (b) rules    bench ⇄ stdio ⇄ `agentfuse wrap` ⇄ stdio ⇄ noop-server.mjs
 * (c) semantic the same, with the semantic tier switched on in the policy
 * ```
 *
 * The proxied side is the **built CLI**, not a hand-rolled host: a benchmark
 * that measured its own wrapper would leave the product's own argument
 * parsing, policy loading, tokenizer, diagnostics and telemetry wiring out of
 * the number, and those are exactly the things that accumulate. It also means
 * the telemetry axis is honest — configuration (c) with telemetry on is a real
 * exporter posting to a real socket, not a stand-in.
 *
 * Every rig passes the parent environment through, because the CLI has to find
 * the model cache the same way a user's would.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { stringify } from 'yaml';
import { callArgs, type Rig, type TelemetryMode } from './inmemory.js';

const NOOP_SERVER = fileURLToPath(new URL('../../latency/noop-server.mjs', import.meta.url));
const CLI_MAIN = fileURLToPath(new URL('../../../packages/cli/dist/main.js', import.meta.url));

/** The parent environment with unset variables dropped, as `wrap` itself does. */
function inheritedEnvironment(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function connect(
  command: string,
  args: string[],
  captureStderr = false,
): Promise<{ client: Client; rig: Rig; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command,
    args,
    env: inheritedEnvironment(),
    ...(captureStderr ? { stderr: 'pipe' as const } : undefined),
  });
  const client = new Client({ name: 'bench', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  let captured = '';
  if (captureStderr) {
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      captured += String(chunk);
    });
  }
  return {
    client,
    stderr: () => captured,
    rig: {
      call: (index) => client.callTool({ name: 'noop', arguments: callArgs(index) }),
      close: () => client.close(),
    },
  };
}

/** (a) — the agent talks to the server directly. */
export async function directStdioRig(): Promise<Rig> {
  return (await connect(process.execPath, [NOOP_SERVER])).rig;
}

/**
 * Asks the wrapped process what its embedding queue actually did.
 *
 * Not part of the timed run — it deliberately leaves `--quiet` off, so the CLI
 * writes diagnostics while it works — but it is what turns the stdio semantic
 * number from a mystery into an explanation. The in-memory tier sheds almost
 * every job because the client calls faster than any model can answer; if the
 * wrapped process shed too, its extra milliseconds would have to come from
 * somewhere else.
 */
export async function semanticQueueProbe(calls: number): Promise<Record<string, number>> {
  const dir = mkdtempSync(join(tmpdir(), 'agentfuse-bench-probe-'));
  const policyPath = join(dir, 'fusepolicy.yaml');
  writeFileSync(
    policyPath,
    stringify({
      version: 1,
      mode: 'warn',
      budgets: { max_calls: 1_000_000, max_duration: '24h' },
      telemetry: { enabled: false },
    }),
    'utf8',
  );

  const { rig, stderr } = await connect(
    process.execPath,
    [
      CLI_MAIN,
      'wrap',
      '--policy',
      policyPath,
      '--name',
      'noop',
      '--',
      process.execPath,
      NOOP_SERVER,
    ],
    true,
  );
  for (let i = 0; i < calls; i += 1) await rig.call(i);
  await rig.close();
  // The child writes `semantic_stats` on its way out; give the inherited pipe a
  // turn of the event loop to deliver the last chunk.
  await new Promise((resolve) => {
    setTimeout(resolve, 250);
  });
  rmSync(dir, { recursive: true, force: true });

  // Diagnostics are `[agentfuse] {json}` on stderr, one per line.
  const line = stderr()
    .split('\n')
    .find((candidate) => candidate.includes('"semantic_stats"'));
  if (line === undefined) return {};
  const brace = line.indexOf('{');
  if (brace < 0) return {};
  const parsed = JSON.parse(line.slice(brace)) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}

/** A throwaway OTLP endpoint that accepts everything and keeps a count. */
export interface Collector {
  readonly endpoint: string;
  readonly received: () => number;
  close(): Promise<void>;
}

/**
 * Starts a collector on a loopback port.
 *
 * It reads each body to completion and answers 200 with an empty object. That
 * is the *cheap* collector, on purpose: a slow one would measure the
 * collector, and the exporter's own behaviour under a slow collector is
 * phase 8's business (it has a 5 s timeout and drops rather than retrying).
 */
export function startCollector(): Promise<Collector> {
  let received = 0;
  const server: HttpServer = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      received += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the collector did not get a port'));
        return;
      }
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        received: () => received,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

/** How a wrapped rig is configured. */
export interface WrappedOptions {
  readonly semantic: boolean;
  readonly telemetry: TelemetryMode;
  /** Required when `telemetry` is `'on'`. */
  readonly endpoint?: string | undefined;
}

/** A wrapped rig plus the temporary directory holding its policy. */
export interface WrappedRig extends Rig {
  readonly policyPath: string;
}

/** (b) and (c) — `agentfuse wrap` between the agent and the same server. */
export async function wrappedStdioRig(options: WrappedOptions): Promise<WrappedRig> {
  const dir = mkdtempSync(join(tmpdir(), 'agentfuse-bench-'));
  const policyPath = join(dir, 'fusepolicy.yaml');
  writeFileSync(
    policyPath,
    stringify({
      version: 1,
      // `warn`, the product's own default. In `enforce` a trip would start
      // denying calls and the run would stop measuring anything.
      mode: 'warn',
      budgets: {
        max_calls: 1_000_000,
        max_duration: '24h',
        max_tokens_estimated: 1_000_000_000,
        max_usd_estimated: 1_000_000,
      },
      loop_detection: options.semantic ? {} : { semantic: { enabled: false, provider: 'none' } },
      telemetry:
        options.telemetry === 'on'
          ? { enabled: true, otlp_endpoint: options.endpoint, service_name: 'agentfuse-bench' }
          : { enabled: false },
    }),
    'utf8',
  );

  const { rig } = await connect(process.execPath, [
    CLI_MAIN,
    'wrap',
    '--policy',
    policyPath,
    '--name',
    'noop',
    '--quiet',
    '--',
    process.execPath,
    NOOP_SERVER,
  ]);

  return {
    policyPath,
    call: rig.call,
    close: async () => {
      await rig.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
