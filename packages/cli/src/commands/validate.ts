/**
 * `agentfuse validate` — check a policy file and say what it means.
 *
 * Two jobs, and the second is the one people actually need.
 *
 * **Say what is wrong, precisely.** Policy objects are Zod `strict`, so a
 * misspelled key is a hard failure at load rather than a silently ignored
 * setting — which is the right behaviour and a useless one if the error says
 * only "invalid document". `config.ts` maps every issue back to a line and
 * column in the file and names the offending key, so the output is a list of
 * editor-jumpable locations.
 *
 * **Say what is right.** A policy that validates still has to be read back: the
 * durations were written as `30m` and are milliseconds inside, the defaults
 * that were left out are now filled in, and `mode` may have been overridden on
 * the command line. Printing the resolved values is how an operator confirms
 * that the file they wrote is the policy they meant — and the `sha256` line is
 * the same one that appears in every trip report, so a report can be traced
 * back to the exact document that produced it.
 */

import { compilePolicy, formatDuration } from '@agentfuse/core';
import { parseArgs } from '../args.js';
import { loadPolicy, POLICY_ENV_VAR, type PolicyOrigin, resolveFromPolicy } from '../config.js';
import { EMBEDDINGS_PACKAGE, semanticRequestOf } from '../embeddings.js';
import { EXIT } from '../errors.js';
import { type CliContext, writeLines } from '../io.js';
import { withMode } from '../runtime.js';
import { asMode, MODE_VALUES } from './shared.js';

/** Flags `validate` accepts. */
export const VALIDATE_FLAGS = {
  booleans: ['json', 'help'],
  values: ['policy', 'mode'],
  aliases: { '-p': '--policy', '-h': '--help' },
} as const;

/** `agentfuse validate --help`. */
export function validateHelp(): string[] {
  return [
    'Usage: agentfuse validate [<path>] [--policy <path>] [--mode warn|enforce] [--json]',
    '',
    'Validates a policy file and prints the resolved settings.',
    '',
    '  <path>           The file to check. Same as --policy.',
    `  --policy <path>  The file to check. Falls back to ${POLICY_ENV_VAR},`,
    '                   then a search upwards from the working directory.',
    `  --mode <mode>    Check as if run with this mode (${MODE_VALUES.join('|')}).`,
    '  --json           Machine-readable output.',
    '',
    'Exit codes: 0 valid, 3 invalid.',
  ];
}

/** Runs `agentfuse validate`. */
export function runValidate(context: CliContext, argv: readonly string[]): number {
  const args = parseArgs(argv, VALIDATE_FLAGS);
  if (args.bool('help')) {
    writeLines(context.stdout, validateHelp());
    return EXIT.ok;
  }

  const flag = args.value('policy') ?? args.positionals[0];
  const loaded = loadPolicy({
    ...(flag !== undefined ? { flag } : undefined),
    env: context.env,
    cwd: context.cwd,
  });

  const policy = withMode(loaded.policy, asMode(args.value('mode')));
  const compiled = compilePolicy(policy);
  const semantic = semanticRequestOf(compiled);
  const reportDir = resolveFromPolicy(loaded, policy.report.dir);

  if (args.bool('json')) {
    writeLines(context.stdout, [
      JSON.stringify(
        {
          valid: true,
          path: loaded.path,
          origin: loaded.origin,
          sha256: compiled.sha256,
          mode: policy.mode,
          reportDir,
          rules: compiled.rules.length,
          semantic: {
            wanted: semantic.wanted,
            providers: semantic.providers,
            models: semantic.models,
          },
          policy,
        },
        null,
        2,
      ),
    ]);
    return EXIT.ok;
  }

  const { budgets, loop_detection: loop } = policy;
  const lines = [
    `${loaded.path} is a valid FusePolicy.`,
    '',
    `  mode             ${policy.mode}${policy.mode === loaded.policy.mode ? '' : ' (overridden by --mode)'}`,
    `  policy sha256    ${compiled.sha256}`,
    `  found via        ${describeOrigin(loaded.origin)}`,
    '',
    '  budgets (per session)',
    `    max_duration            ${formatDuration(budgets.max_duration)}   exact`,
    `    max_calls               ${budgets.max_calls}   exact`,
    `    max_tokens_estimated    ${budgets.max_tokens_estimated}   floor estimate of tool I/O only`,
    `    max_usd_estimated       $${budgets.max_usd_estimated.toFixed(2)}   floor estimate, at $${policy.pricing.input_per_mtok_usd}/$${policy.pricing.output_per_mtok_usd} per Mtok`,
    `    on_exceeded             ${budgets.on_exceeded}`,
    '',
    '  loop detection',
    `    window                  ${loop.window} calls, min_calls ${loop.min_calls}`,
    `    exact_repeat            ${loop.exact_repeat.count}`,
    `    error_repeat            ${loop.error_repeat.count}`,
    `    cycle.max_period        ${loop.cycle.max_period}`,
    `    semantic                ${describeSemantic(semantic.wanted, semantic.providers, loop.semantic.threshold, loop.semantic.consecutive_windows)}`,
    `    on_trip                 ${loop.on_trip}`,
    `    cooldown                ${loop.cooldown.calls} approvals or ${formatDuration(loop.cooldown.duration)}`,
    '',
    `  tool rules       ${compiled.rules.length} (first match wins)`,
    ...compiled.rules.map(
      (rule) =>
        `    ${rule.id.padEnd(10)} ${rule.rule.match.padEnd(24)} ${rule.rule.action}${rule.rule.idempotent ? '  idempotent' : ''}`,
    ),
    '',
    `  reports          ${reportDir}${policy.report.redact_args ? '  (arguments redacted)' : ''}`,
  ];

  if (semantic.wanted && semantic.providers.includes('local')) {
    lines.push(
      '',
      `  Note: the semantic tier needs ${EMBEDDINGS_PACKAGE}, which is not a dependency of this CLI.`,
      `  Without it, mode: warn warns and continues on the deterministic rules; mode: enforce refuses to start.`,
    );
  }

  writeLines(context.stdout, lines);
  return EXIT.ok;
}

/** How the policy file was located, in words. */
function describeOrigin(origin: PolicyOrigin): string {
  if (origin === 'flag') return 'the --policy flag';
  if (origin === 'env') return `the ${POLICY_ENV_VAR} environment variable`;
  return 'a search upwards from the working directory';
}

function describeSemantic(
  wanted: boolean,
  providers: readonly string[],
  threshold: number,
  windows: number,
): string {
  if (!wanted) return 'off';
  return `${providers.join(', ')}, threshold ${threshold}, ${windows} consecutive windows`;
}
