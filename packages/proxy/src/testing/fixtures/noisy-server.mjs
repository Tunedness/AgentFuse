/**
 * A stdio MCP server that is deliberately loud on stderr.
 *
 * Real stdio MCP servers log everything to stderr — that is the only channel
 * they have, because stdout carries JSON-RPC frames. AgentFuse therefore has to
 * pass those bytes through without touching them: a proxy that buffered,
 * re-prefixed, line-split or re-encoded them would make itself look like the
 * thing that broke the server.
 *
 * The exact bytes live in `noise.json`, which the test reads too, so the
 * expectation and the emission cannot drift. See that file's `comment` for what
 * the payload is designed to break.
 *
 * Plain `.mjs` on purpose: it runs under bare `node` with no build step, so the
 * test that spawns it is not testing a transform as well.
 */

import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const noise = JSON.parse(readFileSync(new URL('./noise.json', import.meta.url), 'utf8'));
const startup = [
  ...noise.startup,
  `${noise.longLinePrefix}${'x'.repeat(noise.longLineLength)}\n`,
  noise.tail,
].join('');

process.stderr.write(startup);

const server = new Server(
  { name: 'noisy-server', version: '4.5.6' },
  { capabilities: { tools: {} }, instructions: 'Loud on stderr, quiet on stdout.' },
);

server.setRequestHandler('tools/list', () => ({
  tools: [{ name: 'echo', description: 'Returns its arguments.', inputSchema: { type: 'object' } }],
}));

server.setRequestHandler('tools/call', (request) => {
  process.stderr.write(noise.call);
  return { content: [{ type: 'text', text: JSON.stringify(request.params.arguments ?? {}) }] };
});

serveStdio(() => server);
