#!/usr/bin/env node
/**
 * The `agentfuse` binary. The only file allowed to touch the process.
 *
 * Everything else takes a `CliContext` and returns an exit code, which is what
 * makes the commands testable without intercepting a global — and, in wrap
 * mode, what keeps a stray diagnostic out of the JSON-RPC stream that
 * `process.stdout` becomes. `discipline.test.ts` fails the build if any other
 * source file reaches for `process.stdout`, `process.stderr` or
 * `process.exit`.
 *
 * `process.exitCode` rather than `process.exit()`: an exit code set here lets
 * Node finish flushing stdout and stderr, where `exit()` can truncate the last
 * write — including the error message explaining what went wrong.
 */
import { run } from './cli.js';

process.exitCode = await run({
  argv: process.argv.slice(2),
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
});
