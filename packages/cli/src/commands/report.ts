/**
 * `agentfuse report` — read the trip reports back.
 *
 * The human text is **not** produced here. `renderTripReport` lives in
 * `@agentfuse/core` and is a pure string builder; the proxy prints it to stderr
 * through `renderTripDiagnostic` when a circuit trips, this command prints the
 * same function's output when someone comes back to look, and the test suite
 * snapshots it. One renderer is what makes those three agree, and a second one
 * here would drift from it within a release.
 *
 * So this file is a directory listing and a file read. The report on disk is
 * the JSON object core built; `--json` hands it over untouched, for a script or
 * a Control Plane upload.
 */

import { renderTripReport } from '@agentfuse/core';
import { Diagnostics } from '@agentfuse/proxy';
import { parseArgs } from '../args.js';
import { loadPolicy, resolveFromPolicy } from '../config.js';
import { CliError, EXIT } from '../errors.js';
import { type CliContext, writeLines } from '../io.js';
import { FileReportStore } from '../reports.js';

/** Flags `report` accepts. */
export const REPORT_FLAGS = {
  booleans: ['json', 'help'],
  values: ['policy', 'dir', 'limit'],
  aliases: { '-p': '--policy', '-h': '--help', '-n': '--limit' },
} as const;

/** `agentfuse report --help`. */
export function reportHelp(): string[] {
  return [
    'Usage: agentfuse report [last | list | <trip id>] [--dir <path>] [--json]',
    '',
    'Reads the trip reports AgentFuse wrote when a circuit broke.',
    '',
    '  last             Render the most recent report. The default.',
    '  list             List what is on disk, newest first.',
    '  <trip id>        Render one report, by trip id or filename.',
    '',
    '  --dir <path>     Where the reports are. Defaults to the policy’s report.dir.',
    '  --policy <path>  The policy to read report.dir from.',
    '  --limit, -n <n>  How many rows `list` shows. Default 20.',
    '  --json           Print the stored JSON instead of the rendered report.',
  ];
}

/** Resolves the directory to read, without needing a policy when `--dir` is given. */
function reportDirFor(
  context: CliContext,
  dirFlag: string | undefined,
  policyFlag: string | undefined,
): string {
  if (dirFlag !== undefined) {
    return resolveFromPolicy({ dir: context.cwd }, dirFlag);
  }
  const loaded = loadPolicy({
    ...(policyFlag !== undefined ? { flag: policyFlag } : undefined),
    env: context.env,
    cwd: context.cwd,
  });
  return resolveFromPolicy(loaded, loaded.policy.report.dir);
}

/** Runs `agentfuse report`. */
export function runReport(context: CliContext, argv: readonly string[]): number {
  const args = parseArgs(argv, REPORT_FLAGS);
  if (args.bool('help')) {
    writeLines(context.stdout, reportHelp());
    return EXIT.ok;
  }

  const store = new FileReportStore({
    dir: reportDirFor(context, args.value('dir'), args.value('policy')),
  });
  const target = args.positionals[0] ?? 'last';

  if (target === 'list') return list(context, store, args.value('limit'));

  const entry = target === 'last' ? store.last() : store.find(target);
  if (entry === undefined) {
    throw new CliError('no trip reports yet', {
      exitCode: EXIT.usage,
      hints: [
        `Looked in ${store.dir}.`,
        'Nothing has tripped the breaker, or the policy in force writes its reports somewhere else — `agentfuse validate` prints the directory it would use.',
      ],
    });
  }

  const report = store.read(entry.path);
  if (args.bool('json')) {
    // The machine path stays exactly the JSON core wrote: a script or a
    // Control Plane upload gets the document, with nothing wrapped round it.
    writeLines(context.stdout, [JSON.stringify(report, null, 2)]);
    return EXIT.ok;
  }

  // `block()` rather than a line-by-line write. The proxy's `Diagnostics`
  // exists for exactly this: the rendered report is a box-drawn table, and
  // prefixing every line of it — which is what `emit()` does — destroys the
  // layout somebody is reading during an incident. It writes one marker line
  // and then the text verbatim, so a live trip and a report read back
  // afterwards look the same.
  new Diagnostics({ sink: context.stdout }).block(renderTripReport(report));
  writeLines(context.stdout, ['', `  stored at ${entry.path}`]);
  return EXIT.ok;
}

/** `agentfuse report list`. */
function list(context: CliContext, store: FileReportStore, limitFlag: string | undefined): number {
  const limit = limitFlag === undefined ? 20 : Number(limitFlag);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CliError(`--limit must be a positive integer, not ${limitFlag}`);
  }

  const entries = store.list();
  if (entries.length === 0) {
    writeLines(context.stdout, [`No trip reports in ${store.dir}.`]);
    return EXIT.ok;
  }

  const shown = entries.slice(0, limit);
  const rows = shown.map((entry) => {
    // Reading each one is affordable here and not in `list()` itself: the
    // listing is bounded by `--limit`, and the trigger code is the only thing
    // that makes a row worth scanning.
    //
    // A file that will not read is listed rather than fatal. The directory is
    // the user's, it may hold a truncated write or a report from a newer
    // AgentFuse, and refusing to show the other nine hundred because of one is
    // the wrong trade for a command somebody is running during an incident.
    try {
      const report = store.read(entry.path);
      return `  ${report.trippedAt}  ${report.trigger.code.padEnd(18)} session=${report.sessionId}  ${entry.tripId}`;
    } catch {
      return `  ${entry.stamp.padEnd(24)}  ${'UNREADABLE'.padEnd(18)} ${entry.file}`;
    }
  });

  writeLines(context.stdout, [
    `${entries.length} trip report(s) in ${store.dir}${entries.length > shown.length ? `, showing ${shown.length}` : ''}:`,
    '',
    ...rows,
    '',
    '  agentfuse report <trip id>   to read one',
  ]);
  return EXIT.ok;
}
