import { shortFingerprint } from '../loop/fingerprint.js';
import { formatDuration } from '../policy/duration.js';
import type { ReportedCall, TripReport } from './trip-report.js';

/**
 * The human view of a trip report.
 *
 * A **pure string builder**: no `console`, no colour codes, no I/O. The CLI
 * prints it, the Control Plane will render it in a browser, and the test suite
 * snapshots it — all from the same function, which is only possible because it
 * returns a string and nothing else.
 *
 * Aims to stay under ~25 lines for a typical trip. Someone is reading this
 * while an agent is stuck; anything that does not help them decide what to do
 * next is cut.
 */

const WIDTH = 78;
const BAR_CELLS = 10;
/** Distinct recent-call rows to show before eliding. Keeps the report compact. */
const MAX_ROWS = 8;

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function rule(title: string): string {
  const head = `━━ ${title} `;
  return head + '━'.repeat(Math.max(0, WIDTH - head.length));
}

/** Greedy word wrap; long unbreakable tokens are allowed to overhang. */
function wrap(text: string, width: number, indent: string): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(indent + line);
      line = word;
    }
  }
  if (line !== '') lines.push(indent + line);
  return lines;
}

function bar(ratio: number): string {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(ratio * BAR_CELLS)));
  return `[${'█'.repeat(filled)}${'·'.repeat(BAR_CELLS - filled)}]`;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`.padStart(4);
}

function gaugeRow(label: string, used: string, limit: string, ratio: number): string {
  return `  ${pad(label, 12)}${pad(used, 13)}${pad(limit, 13)}${bar(ratio)}${percent(ratio)}`;
}

function safeRatio(value: number, limit: number): number {
  return limit > 0 ? value / limit : 0;
}

/** Collapses consecutive identical fingerprints into one row with a `×N` glyph. */
interface Row {
  call: ReportedCall;
  repeats: number;
}

function collapse(calls: readonly ReportedCall[]): Row[] {
  const rows: Row[] = [];
  for (const call of calls) {
    const last = rows.at(-1);
    if (last && last.call.fingerprint === call.fingerprint && last.call.isError === call.isError) {
      last.repeats += 1;
    } else {
      rows.push({ call, repeats: 1 });
    }
  }
  return rows;
}

function callRow(row: Row, marker: string): string {
  const { call } = row;
  const status = call.isError ? 'ERR' : 'ok';
  const duration = call.durationMs > 0 ? formatDuration(call.durationMs) : '—';
  const repeat = row.repeats > 1 ? ` ×${row.repeats}` : '';
  const detail = call.isError && call.errorSignature ? call.errorSignature : call.argsPreview;
  return `  ${pad(marker, 3)}${pad(clip(call.tool, 27), 28)}${pad(status, 5)}${pad(duration, 8)}${clip(detail, 26)}${repeat}`;
}

/** Renders a {@link TripReport} as a terminal-ready block of text. */
export function renderTripReport(report: TripReport): string {
  const { budgets, breaker, trigger } = report;
  const lines: string[] = [];

  lines.push(rule('AgentFuse · circuit tripped'));
  lines.push(
    `  ${trigger.code}  session=${report.sessionId}  ${report.trippedAt}  mode=${report.mode}`,
  );
  lines.push(...wrap(trigger.message, WIDTH - 2, '  '));
  lines.push('');

  lines.push(
    `  breaker: ${breaker.phase}  ·  cooldown: ${breaker.cooldown.calls} approvals or ${formatDuration(breaker.cooldown.durationMs)}`,
  );

  // ADR-009: the report is an audit artifact, and the first thing an audit asks
  // of a human-gated call is why the person answered as they did. Next to the
  // breaker line, because that is what their answer moved. The text arrives
  // sanitised and capped from the engine, so it cannot break the ruling below
  // or run past the width — see `util/text.ts`.
  const approval = report.approval;
  if (approval !== undefined) {
    lines.push(`  human: ${approval.verdict}`);
    if (approval.reason !== undefined) lines.push(...wrap(approval.reason, WIDTH - 4, '    '));
  }
  lines.push('');

  const tokens = budgets.tokensEstimated.args + budgets.tokensEstimated.results;
  lines.push(`  ${pad('budget', 12)}${pad('used', 13)}${pad('limit', 13)}`);
  lines.push(
    gaugeRow(
      'calls',
      String(budgets.calls),
      String(budgets.limits.calls),
      safeRatio(budgets.calls, budgets.limits.calls),
    ),
  );
  lines.push(
    gaugeRow(
      'duration',
      formatDuration(budgets.durationMs),
      formatDuration(budgets.limits.durationMs),
      safeRatio(budgets.durationMs, budgets.limits.durationMs),
    ),
  );
  lines.push(
    gaugeRow(
      'tokens ~',
      `${budgets.tokensEstimated.args}+${budgets.tokensEstimated.results}`,
      String(budgets.limits.tokensEstimated),
      safeRatio(tokens, budgets.limits.tokensEstimated),
    ),
  );
  lines.push(
    gaugeRow(
      'usd ~',
      `$${budgets.usdEstimated.toFixed(2)}`,
      `$${budgets.limits.usdEstimated.toFixed(2)}`,
      safeRatio(budgets.usdEstimated, budgets.limits.usdEstimated),
    ),
  );
  // The caveat lives next to the number, not in a footnote elsewhere.
  lines.push(`  ~ ${budgets.tokensEstimated.note}`);
  lines.push('');

  const history = report.recentCalls.slice(0, -1);
  const current = report.recentCalls.at(-1);
  const rows = collapse(history);
  const shown = rows.slice(-MAX_ROWS);

  lines.push('  recent calls (oldest first)');
  if (rows.length > shown.length) {
    lines.push(`  …  ${rows.length - shown.length} earlier call group(s) omitted`);
  }
  for (const [index, row] of shown.entries()) {
    lines.push(callRow(row, String(index + 1)));
  }
  if (current) {
    lines.push(callRow({ call: current, repeats: 1 }, '→'));
  }

  lines.push('');
  lines.push(
    `  policy sha256=${shortFingerprint(report.policy.sha256)}  ·  trip=${report.tripId}  ·  agentfuse ${report.agentfuse.version}`,
  );

  return lines.join('\n');
}
