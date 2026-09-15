/**
 * `agentfuse approve` and `agentfuse deny` — the other end of the socket.
 *
 * These two are the shortest-lived commands in the product: connect, write one
 * frame, read one, print a line, exit. Everything interesting about the channel
 * is in `approvals/socket.ts`; what is here is the command surface.
 *
 * Three decisions worth stating.
 *
 * **`--reason` is required.** A verdict without one is unauditable a week
 * later, and the moment somebody has the context to write it down is the moment
 * they are typing the command. It is recorded in the wrap's `approval_resolved`
 * diagnostic line. It does *not* reach the agent-facing refusal text or the
 * JSON trip report — see the module doc in `approvals/cli-gateway.ts` for why
 * that would need a change to a frozen package.
 *
 * **`--reset` lives on `approve`, not on `deny`.** Resetting a breaker is an
 * act of permission: it says "carry on". `agentfuse deny --reset` is therefore
 * rejected as an unknown flag rather than quietly meaning something.
 *
 * **stdout is for the person who typed this.** Neither command is in the proxy
 * path, so unlike `wrap` they may write there — and they do, one line, so the
 * answer can be captured by a script.
 */

import { resolveApprovalSocketPath } from '../approvals/protocol.js';
import { sendCommand } from '../approvals/socket.js';
import { parseArgs } from '../args.js';
import { CliError, EXIT } from '../errors.js';
import { type CliContext, writeLines } from '../io.js';

/** Flags `approve` accepts. */
export const APPROVE_FLAGS = {
  booleans: ['reset', 'help'],
  values: ['reason', 'session', 'socket'],
  aliases: { '-h': '--help', '-r': '--reason', '-s': '--session' },
} as const;

/** Flags `deny` accepts. The same, without `--reset`. */
export const DENY_FLAGS = {
  booleans: ['help'],
  values: ['reason', 'socket'],
  aliases: { '-h': '--help', '-r': '--reason' },
} as const;

/** `agentfuse approve --help`. */
export function approveHelp(): string[] {
  return [
    'Usage: agentfuse approve <approval id> --reason <why>',
    '       agentfuse approve --session <id> --reset --reason <why>',
    '',
    'Answers a call a policy stopped for a human. The wrap that is waiting',
    'prints the approval id, and the exact command to run, on its stderr.',
    '',
    '  <approval id>         The id from the pending prompt.',
    '  --reason, -r <why>    Required. Recorded in the wrap’s log.',
    '  --session, -s <id>    With --reset: the session whose breaker to close.',
    '  --reset               Close a broken circuit by hand, without answering',
    '                        a specific call.',
    '  --socket <path>       The wrap’s approval socket. Only needed when the',
    '                        prompt printed one, which happens when a second',
    '                        wrap is running and took a fallback path.',
    '',
    'The socket is found at AGENTFUSE_APPROVAL_SOCKET, then',
    '$XDG_RUNTIME_DIR/agentfuse/approvals.sock, then ~/.agentfuse/approvals.sock.',
    '',
    'An approval that nobody answers within approvals.timeout (default 120s) is',
    'denied, and the agent is told so. Setting approvals.on_timeout: allow',
    'forwards it instead — that makes AgentFuse fail OPEN and is not recommended.',
  ];
}

/** `agentfuse deny --help`. */
export function denyHelp(): string[] {
  return [
    'Usage: agentfuse deny <approval id> --reason <why>',
    '',
    'Refuses a call a policy stopped for a human. The agent is told a person',
    'said no, and told not to retry it or look for another tool to do it with.',
    '',
    '  <approval id>         The id from the pending prompt.',
    '  --reason, -r <why>    Required. Recorded in the wrap’s log.',
    '  --socket <path>       The wrap’s approval socket, when the prompt named one.',
    '',
    'In a half-open circuit a refusal also re-opens the breaker: a person saying',
    'no is at least as strong a signal as the rule tripping again.',
  ];
}

/** Reads `--reason`, which both commands insist on. */
function reasonOf(value: string | undefined, command: string): string {
  if (value !== undefined && value.trim() !== '') return value;
  throw new CliError(`${command} needs --reason`, {
    hints: [
      `For example: agentfuse ${command} 01J… --reason "checked the path by hand"`,
      'It is recorded with the verdict, and it is the only thing that explains this decision to whoever reads the log next week.',
    ],
  });
}

/** Where to send the frame. */
function socketFor(context: CliContext, flag: string | undefined): string {
  if (flag !== undefined) return flag;
  // `alt` rather than a pid: a client never binds anything, so the fallback
  // path it would compute is meaningless — and pointing a verdict at a path
  // nobody named would be worse than the error the default path gives.
  return resolveApprovalSocketPath(context.env, 'alt').path;
}

/** Prints the wrap's answer and turns it into an exit code. */
function report(context: CliContext, lines: readonly string[], ok: boolean): number {
  writeLines(context.stdout, lines);
  return ok ? EXIT.ok : EXIT.usage;
}

/** Runs `agentfuse approve`. */
export async function runApprove(context: CliContext, argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, APPROVE_FLAGS);
  if (args.bool('help')) {
    writeLines(context.stdout, approveHelp());
    return EXIT.ok;
  }

  // The arguments first, the socket second: "you forgot --reason" is a more
  // useful first sentence than "I cannot work out where the socket is", and
  // both can be true at once.
  const reason = reasonOf(args.value('reason'), 'approve');

  if (args.bool('reset')) {
    const sessionId = args.value('session');
    if (sessionId === undefined) {
      throw new CliError('approve --reset needs --session <id>', {
        hints: [
          'The session id is in the pending prompt, in every trip report, and in the `session_start` diagnostic line.',
          '`agentfuse report last` prints it for the most recent trip.',
        ],
      });
    }
    const reply = await sendCommand(socketFor(context, args.value('socket')), {
      v: 1,
      type: 'reset',
      sessionId,
      reason,
    });
    return report(
      context,
      [reply.message, ...(reply.phase === undefined ? [] : [`The breaker is now ${reply.phase}.`])],
      reply.ok,
    );
  }

  const approvalId = args.positionals[0];
  if (approvalId === undefined) {
    throw new CliError('approve needs an approval id', {
      hints: [
        'The waiting wrap prints it on its stderr, with the exact command to run.',
        'To close a broken circuit instead: agentfuse approve --session <id> --reset --reason <why>',
      ],
    });
  }

  const reply = await sendCommand(socketFor(context, args.value('socket')), {
    v: 1,
    type: 'verdict',
    approvalId,
    verdict: 'approved',
    reason,
  });
  return report(context, [reply.message], reply.ok);
}

/** Runs `agentfuse deny`. */
export async function runDeny(context: CliContext, argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, DENY_FLAGS);
  if (args.bool('help')) {
    writeLines(context.stdout, denyHelp());
    return EXIT.ok;
  }

  const reason = reasonOf(args.value('reason'), 'deny');
  const approvalId = args.positionals[0];
  if (approvalId === undefined) {
    throw new CliError('deny needs an approval id', {
      hints: ['The waiting wrap prints it on its stderr, with the exact command to run.'],
    });
  }

  const reply = await sendCommand(socketFor(context, args.value('socket')), {
    v: 1,
    type: 'verdict',
    approvalId,
    verdict: 'denied',
    reason,
  });
  return report(context, [reply.message], reply.ok);
}
