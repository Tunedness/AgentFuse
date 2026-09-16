/**
 * `agentfuse init` — write a starter `fusepolicy.yaml`.
 *
 * This file is the first thing most people will read about AgentFuse, so it is
 * treated as a product surface rather than a scaffold. Four properties are
 * load-bearing and each has a test:
 *
 * 1. **`mode: warn`.** The PRD's first-listed risk is that a false positive
 *    breaks a working agent and burns the user's trust. The schema defaults to
 *    `warn` and so does this file, stated explicitly so that turning it up is a
 *    deliberate edit to a visible line rather than the discovery of a default.
 * 2. **The `$schema` line.** `# yaml-language-server: $schema=…` is what makes
 *    an editor validate the file as it is typed. Zod `strict` means a
 *    misspelled key fails at load; this is what lets the user find that out
 *    before AgentFuse has to tell them.
 * 3. **It validates.** `init.test.ts` parses the output and checks it against
 *    the *published JSON Schema* — not merely against the Zod schema — so a
 *    starter file that an editor would underline in red cannot ship.
 * 4. **`max_usd_estimated` carries its caveat.** ADR-007 requires the honesty
 *    note next to the number, because the proxy sees tool I/O and never the
 *    model's own tokens. The PRD promises a USD limit, so the line is here; the
 *    comment above it is what keeps the promise from being a lie.
 *
 * The anchor limits come first, deliberately. ADR-007: `max_duration` and
 * `max_calls` are exactly measurable and the documentation and examples are to
 * explain those before the estimates.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from '../args.js';
import { CliError, EXIT, messageOf } from '../errors.js';
import { type CliContext, writeLines } from '../io.js';

/** Where the published JSON Schema lives. Pinned by a test against core's copy. */
export const SCHEMA_URL = 'https://schemas.tunedness.com/agentfuse/fusepolicy.v1.schema.json';

/** The file `init` writes when no path is given. */
export const DEFAULT_POLICY_FILENAME = 'fusepolicy.yaml';

/**
 * The starter policy.
 *
 * Every value here is the schema's own default written out, with two
 * exceptions, both noted in the comments: `budgets.on_exceeded` and
 * `tools[0].action`. Writing the defaults down rather than omitting them is the
 * point of a starter file — the reader learns what the knobs are called and
 * what they are currently set to, and can raise a limit without first going to
 * find the documentation.
 */
export function starterPolicy(): string {
  return `# yaml-language-server: $schema=${SCHEMA_URL}
#
# AgentFuse — circuit breaker for agent tool calls.
# Docs: https://github.com/tunedness/agentfuse
#
# Every field below is optional. \`version: 1\` on its own is a valid policy and
# means exactly these defaults.

version: 1

# \`warn\` observes and reports; \`enforce\` actually breaks the circuit.
#
# Start here. Run your agent for a while, read the trip reports AgentFuse writes
# under \`report.dir\`, and only switch to \`enforce\` once you believe the trips
# it would have caused are the ones you want. Flipping this line is the whole
# adoption path; \`agentfuse wrap --mode enforce\` tries it without editing.
mode: warn

budgets:
  # These two are exact. AgentFuse measures them directly, so they are the
  # limits to reach for first and the ones to trust.
  max_duration: 30m
  max_calls: 200

  # These two are ESTIMATES, and the \`_estimated\` suffix is not decoration.
  #
  # AgentFuse sits on tools/call: it sees the arguments going to a tool and the
  # result coming back. It does NOT see your model's prompt, its completion, its
  # reasoning tokens, or any turn that called no tool. So this number is a FLOOR
  # on the context your tools injected — real spend is higher, sometimes by a
  # lot. Use it as a tripwire ("something is very wrong"), never as an invoice.
  #
  # Tokens are counted with a real tokenizer (gpt-tokenizer, o200k_base), not a
  # bytes/4 guess, and the dollar figure is that count times the \`pricing\` table
  # at the bottom of this file — AgentFuse cannot know which model you are
  # running, so you declare its prices.
  max_tokens_estimated: 400000
  max_usd_estimated: 5

  # What to do when a budget runs out: halt | require_approval | warn.
  #
  # \`halt\`, unlike the schema's own default, and on purpose: a blown budget is
  # not a transient fault. It never un-blows, so \`require_approval\` here means a
  # prompt for every remaining call of the session rather than one decision.
  # Approval is the right answer for a *tool* — see \`approvals\` at the bottom.
  on_exceeded: halt

loop_detection:
  # How many recent calls the rules look at. Calibrated against the phase 9
  # benchmark corpus: at 8 the deterministic rules alone false-positive on the
  # test-fix-test cycle, because a window that wide sees three runs of one
  # unchanging command across two rounds of edits.
  window: 5
  # Minimum calls before the SEMANTIC rule may score. The deterministic rules
  # below ignore it on purpose, so "same call three times" still trips on the
  # third call.
  min_calls: 5

  # The deterministic tier. No model, no network, no measurable latency — and
  # fully functional on its own, which is why the embedding package is optional.
  exact_repeat:
    # Identical tool + identical arguments, this many times.
    count: 3
  error_repeat:
    # The same error signature, this many times.
    count: 3
  cycle:
    # Detects A→B→A→B and longer rotations up to this period.
    max_period: 4

  # The semantic tier: catches the loop that changes shape every turn but makes
  # no progress. Needs the optional companion package:
  #
  #     npm install @agentfuse/embeddings-local
  #     agentfuse models install
  #
  # Without it, \`mode: warn\` prints a warning and carries on with the rules
  # above; \`mode: enforce\` refuses to start, because you asked to be protected
  # by something that is not installed. Set \`provider: none\` to turn the tier
  # off deliberately and silence both.
  semantic:
    enabled: true
    provider: local
    model: Xenova/all-MiniLM-L6-v2
    # Window score above which the calls count as "the same work". The score is
    # the smaller of two numbers: how alike the requests are, and how much of
    # each answer was already in one of the others. Calibrated on 200 labelled
    # sessions — 87% detection at 0% false positives, with the nearest honest
    # session 0.007 below.
    threshold: 0.905
    consecutive_windows: 1

  # What a tripped loop does: halt | require_approval | warn.
  on_trip: halt

  # How the breaker closes again: this many approved probes, or this much time.
  cooldown:
    calls: 3
    duration: 2m

# Per-tool rules. First match wins; an unmatched tool is allowed.
# \`match\` is a glob against "<server>__<tool>" — the server name is the alias
# you gave it on the command line, so \`read_file\` on two different servers can
# be governed separately.
tools:
  # Replace this with your own rules. A realistic starting set:
  #
  # - match: "fs__read_*"
  #   action: allow
  #   idempotent: true        # repeated identical reads are harmless, so the
  #                           # exact-repeat threshold doubles for this rule
  # - match: "fs__write_*"
  #   action: warn
  #   note: "watch these before enforcing"
  # - match: "shell__*"
  #   action: deny
  #   note: "no shell access for this agent"
  - match: "*"
    action: allow

report:
  # Where trip reports are written. A relative path is resolved against THIS
  # FILE, not the working directory — an MCP client usually launches the proxy
  # from a directory you did not choose.
  dir: .agentfuse/reports
  # How many recent calls a report's table carries.
  recent_calls: 20
  # Replaces argument previews with fingerprints in written reports. Turn this
  # on if tool arguments in your setup carry anything you would not paste into
  # a ticket; repeats are still visible, the values are not.
  redact_args: false

# Prices for the \`max_usd_estimated\` arithmetic, in USD per million tokens.
# AgentFuse has no idea which model you are running, so these are your numbers.
pricing:
  input_per_mtok_usd: 3
  output_per_mtok_usd: 15

# Session identity over HTTP. Only \`agentfuse serve\` reads this — in wrap mode
# one child process is one session, exactly, with nothing to configure.
#
# session:
#   key: auto            # auto | connection | traceparent | baggage:<name>
#   idle_timeout: 10m

# Human approval, for the rules whose \`action\` is \`require_approval\`. Only read
# in \`mode: enforce\` — warn mode never asks anybody.
approvals:
  # How long a call waits for a person before the answer below applies.
  timeout: 120s

  # What an unanswered approval means: deny | allow.
  #
  # Keep \`deny\`. \`allow\` makes AgentFuse fail OPEN — the one call a policy
  # singled out for a human goes through unattended, which is the opposite of
  # what asking for approval was for. AgentFuse warns on every start if you set
  # it. The agent is told either way, and told not to retry.
  on_timeout: deny

  # Where the question goes: cli | webhook. Both may be listed, and then the
  # first channel to answer decides — a channel timing out does not end the
  # request, and a channel that fails denies.
  #
  # \`cli\` prints the pending call on stderr with the exact command to answer it:
  #
  #     agentfuse approve <id> --reason "..."
  #     agentfuse deny <id> --reason "..."
  #
  # It listens on a unix socket at \`$XDG_RUNTIME_DIR/agentfuse/approvals.sock\`,
  # or \`~/.agentfuse/approvals.sock\` where that is unset (macOS), mode 0600
  # inside a 0700 directory. \`AGENTFUSE_APPROVAL_SOCKET\` moves it.
  gateways: [cli]

  # \`webhook\` POSTs the request instead, signed with HMAC-SHA256 over the exact
  # request body. The policy names the ENVIRONMENT VARIABLE holding the shared
  # secret, never the secret: this file is meant to be committed and diffed.
  #
  # webhook:
  #   url: https://example.internal/agentfuse/approvals
  #   secret_env: AGENTFUSE_WEBHOOK_SECRET

# OpenTelemetry export. Not in this build yet, and off unless asked for.
#
# telemetry:
#   enabled: false
#   otlp_endpoint: http://localhost:4318
#   service_name: agentfuse
`;
}

/** Flags `init` accepts. */
export const INIT_FLAGS = {
  booleans: ['force', 'help'],
  values: ['policy'],
  aliases: { '-f': '--force', '-p': '--policy', '-h': '--help' },
} as const;

/** `agentfuse init --help`. */
export function initHelp(): string[] {
  return [
    'Usage: agentfuse init [--policy <path>] [--force]',
    '',
    `Writes a starter policy file (default: ./${DEFAULT_POLICY_FILENAME}).`,
    '',
    '  --policy <path>  Where to write it.',
    '  --force, -f      Overwrite an existing file.',
    '',
    'The starter file defaults to `mode: warn`: AgentFuse observes and writes',
    'reports until you decide its trips are the ones you want.',
  ];
}

/** Runs `agentfuse init`. */
export function runInit(context: CliContext, argv: readonly string[]): number {
  const args = parseArgs(argv, INIT_FLAGS);
  if (args.bool('help')) {
    writeLines(context.stdout, initHelp());
    return EXIT.ok;
  }

  const requested = args.value('policy') ?? DEFAULT_POLICY_FILENAME;
  const path = isAbsolute(requested) ? requested : resolve(context.cwd, requested);

  if (existsSync(path) && !args.bool('force')) {
    throw new CliError(`${path} already exists`, {
      hints: [
        'Pass --force to overwrite it, or --policy <path> to write somewhere else.',
        'Run `agentfuse validate` to check the file that is already there.',
      ],
    });
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, starterPolicy(), 'utf8');
  } catch (error) {
    throw new CliError(`cannot write ${path}`, {
      exitCode: EXIT.runtime,
      hints: [messageOf(error)],
      cause: error,
    });
  }

  const shown = relative(context.cwd, path) || path;
  writeLines(context.stdout, [
    `Wrote ${shown}`,
    '',
    'It starts in `mode: warn`, which observes and reports without blocking anything.',
    '',
    'Next:',
    `  agentfuse validate                       # check it`,
    `  agentfuse wrap -- <your mcp server cmd>  # put the fuse in front of it`,
    '',
    'Semantic loop detection needs one more install, and says so if you leave it on:',
    '  npm install @agentfuse/embeddings-local && agentfuse models install',
  ]);
  return EXIT.ok;
}
