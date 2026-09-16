/**
 * The cheapest possible MCP server, so what is measured is the interposition
 * and not the tool.
 *
 * `tools/call` returns a fixed-size text block and does nothing else: no file
 * system, no timers, no allocation that grows with the call count. Anything
 * that varied here would show up in the latency distribution and be
 * indistinguishable from AgentFuse's own cost, which is the one thing this
 * benchmark exists to isolate.
 *
 * Silent on stderr, like `packages/proxy/src/testing/fixtures/quiet-server.mjs`
 * and for the same reason: when it runs as a wrapped child its stderr is
 * inherited straight through to the benchmark's own.
 */

import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

/**
 * A ~256-byte answer that carries the request's own path back.
 *
 * The varying part is not decoration. A tool that returned the *identical*
 * string to every call would make the semantic rule's staleness term 1.0 on
 * every window, the breaker would trip, and from then on the benchmark would be
 * timing trip-report construction instead of steady-state interposition. Real
 * tools answer differently to different requests; so does this one, for the
 * price of one concatenation.
 */
const FILLER = 'ok '.repeat(80);
const payload = (args) => `${String(args?.path ?? 'none')} ${FILLER}`.slice(0, 256);

const server = new Server(
  { name: 'noop', version: '1.0.0' },
  { capabilities: { tools: {} }, instructions: 'Answers immediately.' },
);

server.setRequestHandler('tools/list', () => ({
  tools: [{ name: 'noop', description: 'Answers immediately.', inputSchema: { type: 'object' } }],
}));

server.setRequestHandler('tools/call', (request) => ({
  content: [{ type: 'text', text: payload(request.params.arguments) }],
}));

serveStdio(() => server);
