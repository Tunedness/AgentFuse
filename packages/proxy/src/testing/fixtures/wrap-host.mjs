/**
 * A real `agentfuse wrap` in a real process, for the fidelity tests.
 *
 * The two claims wrap mode makes about the streams cannot be tested in-process:
 * "the child's stderr flows through byte-for-byte" is a property of the fd the
 * child inherits, and "stdout carries nothing but protocol frames" is a
 * property of this process's stdout. Both need a process whose stdio the test
 * owns, so the test spawns this.
 *
 * It imports the **built** packages, because it runs under bare `node` with no
 * transform. The gate runs `npm run build` before `npm test`, and every proxy
 * test already reads `@agentfuse/core` from `dist`; the test that spawns this
 * fails with a pointed message if `dist` is missing.
 *
 * Arguments: the path to the child MCP server to wrap. Env: `AGENTFUSE_QUIET=1`
 * silences AgentFuse's own stderr, which is what makes the byte comparison
 * possible.
 */

import { CounterIdGenerator, FuseEngine, parsePolicy } from '@agentfuse/core';
import { wrapStdioServer } from '@agentfuse/proxy';

const childPath = process.argv[2];
if (childPath === undefined) {
  process.stderr.write('wrap-host: no child server path given\n');
  process.exit(2);
}

const engine = new FuseEngine(
  parsePolicy({
    version: 1,
    mode: process.env.AGENTFUSE_MODE === 'enforce' ? 'enforce' : 'warn',
    loop_detection: { exact_repeat: { count: 2 } },
  }),
  { ids: new CounterIdGenerator('session') },
);

const handle = wrapStdioServer({
  command: process.execPath,
  args: [childPath],
  engine,
  serverName: 'noisy',
  quiet: process.env.AGENTFUSE_QUIET === '1',
});

// A wrap ends when its pipes do. Nothing here writes to stdout: the only writer
// is the SDK's StdioServerTransport, which is the whole point of the test.
process.stdin.on('close', () => {
  void handle.close();
});
