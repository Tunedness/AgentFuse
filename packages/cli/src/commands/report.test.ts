import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderTripReport, type TripReport } from '@agentfuse/core';
import { DIAGNOSTIC_PREFIX } from '@agentfuse/proxy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliError } from '../errors.js';
import { type CliContext, StringWriter } from '../io.js';
import { FileReportStore } from '../reports.js';
import { reportHelp, runReport } from './report.js';

let root: string;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentfuse-report-cmd-'));
  stdout = new StringWriter();
  stderr = new StringWriter();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return path;
}

function context(): CliContext {
  return { argv: [], stdout, stderr, env: {}, cwd: root };
}

/** A trip report with the fields the renderer and the listing read. */
function report(options: { tripId: string; at: string; code?: string }): TripReport {
  return {
    reportVersion: 1,
    kind: 'trip',
    tripId: options.tripId,
    sessionId: `SESSION-${options.tripId}`,
    trippedAt: options.at,
    mode: 'enforce',
    trigger: {
      code: (options.code ?? 'LOOP_EXACT_REPEAT') as TripReport['trigger']['code'],
      message: 'The same call, three times. Stop and say what you are stuck on.',
      evidence: { count: 3 },
    },
    breaker: { phase: 'open', cooldown: { calls: 3, durationMs: 120_000 } },
    budgets: {
      durationMs: 61_000,
      calls: 12,
      tokensEstimated: { args: 400, results: 1_200, note: 'tool-I/O floor estimate' },
      usdEstimated: 0.02,
      limits: {
        durationMs: 1_800_000,
        calls: 200,
        tokensEstimated: 400_000,
        usdEstimated: 5,
      },
    },
    recentCalls: [
      {
        id: 'CALL1',
        tool: 'fs__read_file',
        fingerprint: 'abc123abc123',
        isError: false,
        durationMs: 12,
        startedAt: options.at,
        argsPreview: '{"path":"a.ts"}',
      },
    ],
    policy: { sha256: 'deadbeefdeadbeef', version: 1 },
    agentfuse: { version: '0.0.0' },
  };
}

/** Writes reports into a directory the command will find through a policy. */
function seed(dir: string, reports: readonly TripReport[]): FileReportStore {
  const store = new FileReportStore({ dir });
  for (const one of reports) store.write(one);
  return store;
}

const POLICY = 'version: 1\nreport:\n  dir: trips\n';

describe('runReport last', () => {
  it('renders the newest report through core`s renderer, unmangled', () => {
    write('fusepolicy.yaml', POLICY);
    const newest = report({ tripId: 'NEW', at: '2026-09-15T12:00:00.000Z' });
    seed(join(root, 'trips'), [report({ tripId: 'OLD', at: '2026-09-14T12:00:00.000Z' }), newest]);

    expect(runReport(context(), [])).toBe(0);

    // The exact text core produces, verbatim. A second renderer here would
    // drift from the one the proxy prints on a live trip within a release.
    expect(stdout.text).toContain(renderTripReport(newest));
    expect(stdout.text).toContain('SESSION-NEW');
    expect(stdout.text).not.toContain('SESSION-OLD');
  });

  it('keeps the box-drawn table intact rather than prefixing every line', () => {
    write('fusepolicy.yaml', POLICY);
    const one = report({ tripId: 'ONE', at: '2026-09-15T12:00:00.000Z' });
    seed(join(root, 'trips'), [one]);

    runReport(context(), []);

    // Verbatim, line for line: prefixing each one — which is what writing the
    // report through `Diagnostics.emit` would do — destroys the layout somebody
    // is reading during an incident.
    for (const line of renderTripReport(one).split('\n')) {
      expect(stdout.text).toContain(line);
    }
  });

  it('puts nothing but the report on stdout — no diagnostic marker line', () => {
    write('fusepolicy.yaml', POLICY);
    const one = report({ tripId: 'ONE', at: '2026-09-15T12:00:00.000Z' });
    seed(join(root, 'trips'), [one]);

    runReport(context(), []);

    // Phase 6a routed this through `Diagnostics.block()`, which writes a
    // `[agentfuse] {"event":"trip_report",…}` marker before the text. That
    // marker belongs in the proxy, where the block sits in a stream of prefixed
    // lines; here it lands inside `agentfuse report last > incident.txt`. This
    // command is not in the proxy path, so its stdout is the human's.
    expect(stdout.text).not.toContain(DIAGNOSTIC_PREFIX);
    expect(stdout.text).not.toContain('"event"');
    expect(stdout.text.startsWith(renderTripReport(one))).toBe(true);
  });

  it('is clean on the --json path too, which a script parses whole', () => {
    write('fusepolicy.yaml', POLICY);
    const one = report({ tripId: 'ONE', at: '2026-09-15T12:00:00.000Z' });
    seed(join(root, 'trips'), [one]);

    runReport(context(), ['--json']);

    // Not merely free of a prefix: the whole stream has to parse as the one
    // document core wrote, with nothing wrapped round it.
    expect(JSON.parse(stdout.text)).toEqual(one);
  });

  it('says where the report is stored', () => {
    write('fusepolicy.yaml', POLICY);
    seed(join(root, 'trips'), [report({ tripId: 'ONE', at: '2026-09-15T12:00:00.000Z' })]);

    runReport(context(), []);

    expect(stdout.text).toContain(`stored at ${join(root, 'trips')}`);
  });

  it('defaults to `last` when no target is given', () => {
    write('fusepolicy.yaml', POLICY);
    seed(join(root, 'trips'), [report({ tripId: 'ONE', at: '2026-09-15T12:00:00.000Z' })]);

    runReport(context(), []);
    const implicit = stdout.text;
    stdout.clear();
    runReport(context(), ['last']);

    expect(stdout.text).toBe(implicit);
  });

  it('says nothing has tripped when the directory is empty, and where it looked', () => {
    write('fusepolicy.yaml', POLICY);

    try {
      runReport(context(), []);
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as CliError).message).toBe('no trip reports yet');
      expect((error as CliError).hints.join(' ')).toContain(join(root, 'trips'));
      expect((error as CliError).hints.join(' ')).toContain('agentfuse validate');
    }
  });

  it('prints the stored JSON untouched with --json', () => {
    write('fusepolicy.yaml', POLICY);
    const one = report({ tripId: 'ONE', at: '2026-09-15T12:00:00.000Z' });
    seed(join(root, 'trips'), [one]);

    runReport(context(), ['--json']);

    expect(JSON.parse(stdout.text)).toEqual(one);
  });
});

describe('runReport <trip id>', () => {
  it('renders one report by trip id', () => {
    write('fusepolicy.yaml', POLICY);
    seed(join(root, 'trips'), [
      report({ tripId: 'AAA', at: '2026-09-14T12:00:00.000Z' }),
      report({ tripId: 'BBB', at: '2026-09-15T12:00:00.000Z' }),
    ]);

    runReport(context(), ['AAA']);

    expect(stdout.text).toContain('SESSION-AAA');
  });

  it('renders one report by filename', () => {
    write('fusepolicy.yaml', POLICY);
    const store = seed(join(root, 'trips'), [
      report({ tripId: 'AAA', at: '2026-09-14T12:00:00.000Z' }),
    ]);
    const file = store.list()[0]?.file as string;

    runReport(context(), [file]);

    expect(stdout.text).toContain('SESSION-AAA');
  });

  it('says what it could not find', () => {
    write('fusepolicy.yaml', POLICY);
    seed(join(root, 'trips'), [report({ tripId: 'AAA', at: '2026-09-14T12:00:00.000Z' })]);

    expect(() => runReport(context(), ['ZZZ'])).toThrow(/no report matches ZZZ/);
  });
});

describe('runReport list', () => {
  it('lists newest first, with the trigger code', () => {
    write('fusepolicy.yaml', POLICY);
    seed(join(root, 'trips'), [
      report({ tripId: 'AAA', at: '2026-09-14T12:00:00.000Z', code: 'BUDGET_CALLS' }),
      report({ tripId: 'BBB', at: '2026-09-15T12:00:00.000Z', code: 'LOOP_SEMANTIC' }),
    ]);

    expect(runReport(context(), ['list'])).toBe(0);
    const lines = stdout.lines;

    expect(lines[0]).toContain('2 trip report(s)');
    expect(lines[1]).toContain('LOOP_SEMANTIC');
    expect(lines[2]).toContain('BUDGET_CALLS');
  });

  it('says the directory is empty rather than failing', () => {
    write('fusepolicy.yaml', POLICY);

    expect(runReport(context(), ['list'])).toBe(0);
    expect(stdout.text).toContain('No trip reports in');
  });

  it('honours --limit and says it truncated', () => {
    write('fusepolicy.yaml', POLICY);
    seed(join(root, 'trips'), [
      report({ tripId: 'AAA', at: '2026-09-13T12:00:00.000Z' }),
      report({ tripId: 'BBB', at: '2026-09-14T12:00:00.000Z' }),
      report({ tripId: 'CCC', at: '2026-09-15T12:00:00.000Z' }),
    ]);

    runReport(context(), ['list', '-n', '1']);

    expect(stdout.text).toContain('showing 1');
    expect(stdout.text).toContain('CCC');
    expect(stdout.text).not.toContain('AAA');
  });

  it('rejects a --limit that is not a positive integer', () => {
    write('fusepolicy.yaml', POLICY);

    expect(() => runReport(context(), ['list', '--limit', '0'])).toThrow(/positive integer/);
    expect(() => runReport(context(), ['list', '--limit', 'ten'])).toThrow(/positive integer/);
  });

  it('lists a file it cannot read instead of failing the whole listing', () => {
    // The directory is the user's: a truncated write or a report from a newer
    // AgentFuse must not hide the other nine hundred.
    write('fusepolicy.yaml', POLICY);
    seed(join(root, 'trips'), [report({ tripId: 'GOOD', at: '2026-09-15T12:00:00.000Z' })]);
    write('trips/2026-09-16T00-00-00-000Z__BROKEN.json', '{ truncated');

    expect(runReport(context(), ['list'])).toBe(0);
    expect(stdout.text).toContain('UNREADABLE');
    expect(stdout.text).toContain('GOOD');
  });
});

describe('where runReport looks', () => {
  it('uses the policy`s report.dir by default', () => {
    write('fusepolicy.yaml', POLICY);

    runReport(context(), ['list']);

    expect(stdout.text).toContain(join(root, 'trips'));
  });

  it('takes --dir instead, needing no policy at all', () => {
    // A user handed a report directory by a colleague has no policy for it.
    seed(join(root, 'elsewhere'), [report({ tripId: 'ONE', at: '2026-09-15T12:00:00.000Z' })]);

    expect(runReport(context(), ['list', '--dir', 'elsewhere'])).toBe(0);
    expect(stdout.text).toContain(join(root, 'elsewhere'));
  });

  it('reads report.dir from the policy --policy names', () => {
    write('other/fusepolicy.yaml', 'version: 1\nreport:\n  dir: theirs\n');
    seed(join(root, 'other', 'theirs'), [
      report({ tripId: 'ONE', at: '2026-09-15T12:00:00.000Z' }),
    ]);

    runReport(context(), ['list', '--policy', 'other/fusepolicy.yaml']);

    expect(stdout.text).toContain(join(root, 'other', 'theirs'));
  });
});

describe('runReport --help', () => {
  it('prints the usage', () => {
    expect(runReport(context(), ['--help'])).toBe(0);
    expect(stdout.lines).toEqual(reportHelp().filter((line) => line !== ''));
  });
});
