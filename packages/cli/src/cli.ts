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

import { runApprove, runDeny } from './commands/approve.js';
import { runInit } from './commands/init.js';
import { runModels } from './commands/models.js';
import { runReport } from './commands/report.js';
import { runServe } from './commands/serve.js';
import { runValidate } from './commands/validate.js';
import { runWrap } from './commands/wrap.js';
import { CliError, EXIT, formatCliError } from './errors.js';
import { versionBanner } from './index.js';
import { type CliContext, writeLines } from './io.js';

/** The commands this build answers to. */
export const COMMANDS = [
  'wrap',
  'serve',
  'init',
  'validate',
  'report',
  'approve',
  'deny',
  'models',
] as const;

/** One of {@link COMMANDS}. */
export type Command = (typeof COMMANDS)[number];

/**
 * The commands this build names but does not carry.
 *
 * Empty since phase 6b wired up `wrap` and `serve`. The constant stays because
 * the shape it enforces is worth keeping: a command in {@link COMMANDS} is
 * either implemented or listed here and refused with an exit code — never
 * silently missing, because `agentfuse wrap` must not look like a misspelling.
 *
 * Note that "implemented" is not "does everything its name suggests". `serve`
 * is here no longer because it binds an endpoint and resolves session identity
 * for real; what it does *not* do — forward tool calls — is stated in its own
 * `--help` rather than by refusing the whole command.
 */
export const PHASE_6B_COMMANDS: readonly Command[] = [];

/** `agentfuse --help`. */
export function usage(): string[] {
  return [
    "agentfuse — put a fuse in front of your agent's tools.",
    '',
    'Usage: agentfuse <command> [options]',
    '',
    '  wrap -- <cmd>    Run an MCP server behind the breaker.',
    '  serve            Bind an HTTP endpoint and resolve session identity.',
    '  init             Write a starter fusepolicy.yaml.',
    '  validate         Check a policy file and print what it resolves to.',
    '  report           Read the trip reports written when a circuit broke.',
    '  approve <id>     Let through a call a policy stopped for a human.',
    '  deny <id>        Refuse one.',
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
    case 'approve':
      return await runApprove(context, rest);
    case 'deny':
      return await runDeny(context, rest);
    case 'models':
      return await runModels(context, rest);
    case 'wrap':
      return await runWrap(context, rest);
    case 'serve':
      return await runServe(context, rest);
  }
  // No `default`: the switch is exhaustive over `Command`, so adding an entry
  // to `COMMANDS` fails the build until it is wired up here.
}
