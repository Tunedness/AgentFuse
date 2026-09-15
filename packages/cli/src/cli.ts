/**
 * The command table, and the one place a {@link CliError} becomes an exit code.
 *
 * Separate from `main.ts` on purpose. `main.ts` binds the real streams, the
 * real `process.argv` and the real exit; everything above it takes a
 * {@link CliContext} and returns a number, so the whole surface is exercised
 * by passing strings in and reading strings out. `discipline.test.ts` keeps
 * that split honest: no file but `main.ts` may touch `process.stdout`,
 * `process.stderr` or `process.exit`.
 *
 * Dispatch is a lookup, not a framework. Each command owns its own flag
 * declaration and its own `--help`, because a central table of every flag in
 * the product is a second thing to keep in step with the first.
 */

import { runInit } from './commands/init.js';
import { runModels } from './commands/models.js';
import { runReport } from './commands/report.js';
import { runValidate } from './commands/validate.js';
import { CliError, EXIT, formatCliError } from './errors.js';
import { versionBanner } from './index.js';
import { type CliContext, writeLines } from './io.js';

/** The commands this build answers to. */
export const COMMANDS = ['wrap', 'serve', 'init', 'validate', 'report', 'models'] as const;

/** One of {@link COMMANDS}. */
export type Command = (typeof COMMANDS)[number];

/**
 * The commands phase 6b owns.
 *
 * `wrap` is almost entirely a `wrapStdioServer()` call and `serve` is the HTTP
 * gateway; both sit on top of `createRuntime`, which is finished and tested.
 * They are named here and refused with an exit code rather than omitted from
 * the table, so `agentfuse wrap` says what is going on instead of suggesting
 * that the user misspelled something.
 */
export const PHASE_6B_COMMANDS: readonly Command[] = ['wrap', 'serve'];

/** `agentfuse --help`. */
export function usage(): string[] {
  return [
    "agentfuse — put a fuse in front of your agent's tools.",
    '',
    'Usage: agentfuse <command> [options]',
    '',
    '  wrap -- <cmd>    Run an MCP server behind the breaker. (not in this build)',
    '  serve            Serve the breaker over HTTP. (not in this build)',
    '  init             Write a starter fusepolicy.yaml.',
    '  validate         Check a policy file and print what it resolves to.',
    '  report           Read the trip reports written when a circuit broke.',
    '  models install   Download the local embedding model.',
    '',
    '  --version, -v    Print the versions of the packages that shipped together.',
    '  --help, -h       This text. `agentfuse <command> --help` for one command.',
    '',
    'A policy is found at --policy, then AGENTFUSE_POLICY, then fusepolicy.yaml',
    'searched upwards from the working directory. It starts in `mode: warn`:',
    'AgentFuse observes and writes reports until you decide its trips are the',
    'ones you want.',
  ];
}

/** Whether a token names a command. */
function isCommand(token: string): token is Command {
  return (COMMANDS as readonly string[]).includes(token);
}

/**
 * Runs one command and returns its exit code.
 *
 * Every {@link CliError} is caught here and printed as a message plus its
 * hints — no stack trace, because a stack tells the user about AgentFuse's
 * internals when what they need is the key they misspelled. Anything else is a
 * bug in AgentFuse and is allowed to escape with its stack intact.
 */
export async function run(context: CliContext): Promise<number> {
  try {
    return await dispatch(context);
  } catch (error) {
    if (error instanceof CliError) {
      context.stderr.write(formatCliError(error));
      return error.exitCode;
    }
    throw error;
  }
}

async function dispatch(context: CliContext): Promise<number> {
  const [first, ...rest] = context.argv;

  if (first === undefined) {
    // No arguments is not a failure, but it is not a success either: a shell
    // script that runs `agentfuse` and ignores the exit code should not think
    // it did something.
    writeLines(context.stdout, usage());
    return EXIT.usage;
  }

  if (first === '--version' || first === '-v') {
    writeLines(context.stdout, [versionBanner()]);
    return EXIT.ok;
  }

  if (first === '--help' || first === '-h') {
    writeLines(context.stdout, usage());
    return EXIT.ok;
  }

  if (!isCommand(first)) {
    throw new CliError(`unknown command: ${first}`, {
      hints: [
        `The commands are: ${COMMANDS.join(', ')}.`,
        'Run `agentfuse --help` for what each one does.',
      ],
    });
  }

  switch (first) {
    case 'init':
      return runInit(context, rest);
    case 'validate':
      return runValidate(context, rest);
    case 'report':
      return runReport(context, rest);
    case 'models':
      return await runModels(context, rest);
    // TODO(phase-6b): `wrap` and `serve` land here. `createRuntime` in
    // `runtime.ts` already returns what `wrapStdioServer` needs — engine,
    // diagnostics, `writeReport`, `onSessionEnd` — so what is missing is the
    // transport and the child process, not the decision machinery.
    case 'wrap':
    case 'serve':
      throw notImplemented(first);
  }
  // No `default`: the switch is exhaustive over `Command`, so adding an entry
  // to `COMMANDS` fails the build until it is wired up here.
}

/** The refusal for a command this build names but does not carry. */
function notImplemented(command: Command): CliError {
  return new CliError(`\`agentfuse ${command}\` is not implemented yet`, {
    exitCode: EXIT.usage,
    hints: [
      'The policy, budget and loop-detection machinery is complete and tested; the serving entry points are the next piece of work.',
      'In the meantime `agentfuse validate` checks a policy and `agentfuse report` reads the reports back.',
    ],
  });
}
