/**
 * A stdio MCP server written straight onto the wire, with no SDK.
 *
 * Two reasons it is raw rather than built on `@modelcontextprotocol/server`.
 *
 * 1. **This package does not depend on the MCP SDK**, by design and by test:
 *    `discipline.test.ts` pins the CLI's dependency list to four packages,
 *    because that list is what `npx agentfuse` downloads. A fixture that
 *    imported the SDK would be relying on a package this workspace happens to
 *    hoist, which is exactly the kind of edge the test exists to stop.
 * 2. **The tests it serves are about bytes.** They assert that the child's
 *    stderr arrives byte-for-byte and that the wrap's stdout carries nothing
 *    but frames, so the fixture has to control precisely what it writes and
 *    when — including a non-UTF-8 sequence and a line with no terminator,
 *    which no logging helper would let through unchanged.
 *
 * It speaks the legacy era (`2025-11-25`), because that is what an agent
 * opening with `initialize` gets and what the proxy then negotiates upstream.
 *
 * Configuration, all through the environment, because that is the channel
 * `wrapStdioServer` passes through to the child:
 *
 * - `FIXTURE_NOISE` — hex bytes written to stderr at startup.
 * - `FIXTURE_CALL_NOISE` — hex bytes written to stderr on every `tools/call`.
 * - `FIXTURE_DIE_AFTER_MS` — exit this long after the first request arrives.
 * - `FIXTURE_EXIT_CODE` — the status to exit with then. Default 3.
 * - `FIXTURE_IDEMPOTENT` — advertise `idempotentHint` on the `echo` tool.
 * - `FIXTURE_ECHO_META` — have `echo` answer with the request's `_meta` as well
 *   as its arguments, which is how a test sees what the proxy forwarded
 *   upstream (SEP-414's `traceparent` lives there).
 */

const PROTOCOL_VERSION = '2025-11-25';
const SERVER_INFO = { name: 'raw-server', version: '1.2.3' };

const TOOLS = [
  {
    name: 'echo',
    description: 'Returns its arguments.',
    inputSchema: { type: 'object' },
    ...(process.env.FIXTURE_IDEMPOTENT === '1'
      ? { annotations: { idempotentHint: true, readOnlyHint: true, title: 'Echo' } }
      : {}),
  },
  { name: 'boom', description: 'Answers with isError.', inputSchema: { type: 'object' } },
];

function bytes(name) {
  const hex = process.env[name];
  return hex === undefined || hex === '' ? undefined : Buffer.from(hex, 'hex');
}

const startupNoise = bytes('FIXTURE_NOISE');
if (startupNoise !== undefined) process.stderr.write(startupNoise);

const callNoise = bytes('FIXTURE_CALL_NOISE');
const dieAfterMs = Number(process.env.FIXTURE_DIE_AFTER_MS ?? '0');
let dying = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function handle(message) {
  if (dieAfterMs > 0 && !dying) {
    dying = true;
    setTimeout(() => {
      process.exit(Number(process.env.FIXTURE_EXIT_CODE ?? '3'));
    }, dieAfterMs);
  }

  // A notification. Nothing to answer, and answering would be a protocol error.
  if (message.id === undefined || message.id === null) return;

  switch (message.method) {
    case 'initialize':
      result(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
        instructions: 'Raw on the wire.',
      });
      return;
    case 'ping':
      result(message.id, {});
      return;
    case 'tools/list':
      result(message.id, { tools: TOOLS });
      return;
    case 'tools/call': {
      if (callNoise !== undefined) process.stderr.write(callNoise);
      const params = message.params ?? {};
      if (params.name === 'boom') {
        result(message.id, {
          content: [{ type: 'text', text: 'the widget exploded' }],
          isError: true,
        });
        return;
      }
      const echoed =
        process.env.FIXTURE_ECHO_META === '1'
          ? { arguments: params.arguments ?? {}, _meta: params._meta ?? {} }
          : (params.arguments ?? {});
      result(message.id, {
        content: [{ type: 'text', text: JSON.stringify(echoed) }],
      });
      return;
    }
    default:
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
  }
}

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf('\n');
    if (newline === -1) break;
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line === '') continue;
    handle(JSON.parse(line));
  }
});
process.stdin.on('close', () => {
  process.exit(0);
});
