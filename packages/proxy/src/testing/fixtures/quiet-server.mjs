/**
 * A stdio MCP server that says nothing on stderr.
 *
 * The twin of `noisy-server.mjs`, for the in-process wrap tests. Those spawn a
 * real child whose stderr is inherited — it lands on the *test runner's* stderr
 * and cannot be captured — so the child used there has to be quiet or every
 * run buries its own output.
 */

import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const server = new Server(
  { name: 'quiet-server', version: '7.8.9' },
  { capabilities: { tools: {}, resources: {} }, instructions: 'Says nothing.' },
);

server.setRequestHandler('tools/list', () => ({
  tools: [{ name: 'echo', description: 'Returns its arguments.', inputSchema: { type: 'object' } }],
}));

server.setRequestHandler('tools/call', (request) => ({
  content: [{ type: 'text', text: JSON.stringify(request.params.arguments ?? {}) }],
}));

server.setRequestHandler('resources/list', () => ({
  resources: [{ uri: 'file:///quiet', name: 'quiet' }],
}));

serveStdio(() => server);
