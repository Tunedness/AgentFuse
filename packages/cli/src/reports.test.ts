import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTripReport,
  CounterIdGenerator,
  compilePolicy,
  type Decision,
  defaultPolicy,
  FakeClock,
  fingerprint,
  InMemorySessionStore,
  normalizeArgs,
  type ToolCallRecord,
  type TripReport,
} from '@agentfuse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from './errors.js';
import { FileReportStore, isTripReport, REPORT_SUFFIX } from './reports.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentfuse-reports-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A real trip report, built by core, so the fixtures are not hand-made JSON. */
function tripReport(
  options: { at: number; tripId: string } = { at: 0, tripId: 'TRIP1' },
): TripReport {
  const clock = new FakeClock(1_700_000_000_000 + options.at);
  const policy = compilePolicy(defaultPolicy());
  const sessions = new InMemorySessionStore();
  const session = sessions.create('SESSION1', clock.now());
  const ids = new CounterIdGenerator();
  const args = { path: 'src/engine.ts' };
  const argsNormalized = normalizeArgs(args, clock.now());
  const current: ToolCallRecord = {
    id: ids.next(),
    sessionId: session.sessionId,
    serverName: 'fs',
    toolName: 'read_file',
    args,
    argsNormalized,
    fingerprint: fingerprint('fs', 'read_file', argsNormalized),
    startedAt: clock.now(),
  };

  return {
    ...buildTripReport({
      tripId: options.tripId,
      policy,
      session,
      current,
      trigger: { code: 'LOOP_EXACT_REPEAT', message: 'The same call, three times.' },
      loop: policy.policy.loop_detection,
      now: clock.now(),
    }),
    tripId: options.tripId,
  };
}

describe('FileReportStore.write', () => {
  it('creates report.dir on first write and returns the absolute path', () => {
    const dir = join(root, 'nested', 'reports');
    const store = new FileReportStore({ dir });

    const path = store.write(tripReport());

    expect(path).toBeDefined();
    expect(path?.startsWith(dir)).toBe(true);
    expect(store.written).toBe(1);
    expect(store.failed).toBe(0);
  });

  it('writes the report core built, unchanged and pretty-printed', () => {
    const store = new FileReportStore({ dir: root });
    const report = tripReport();

    const path = store.write(report);

    const onDisk: unknown = JSON.parse(readFileSync(path as string, 'utf8'));
    expect(onDisk).toEqual(report);
    expect(readFileSync(path as string, 'utf8')).toContain('\n  "kind": "trip"');
    expect(readFileSync(path as string, 'utf8').endsWith('\n')).toBe(true);
  });

  it('names the file so a lexicographic sort is chronological', () => {
    const store = new FileReportStore({ dir: root });

    store.write(tripReport({ at: 0, tripId: 'AAA' }));
    store.write(tripReport({ at: 90_000, tripId: 'BBB' }));
    store.write(tripReport({ at: 45_000, tripId: 'CCC' }));

    // Newest first, by name alone — nothing was opened to work this out.
    expect(store.list().map((entry) => entry.tripId)).toEqual(['BBB', 'CCC', 'AAA']);
  });

  it('keeps the name portable, because a report nobody on Windows can open is not a report', () => {
    const store = new FileReportStore({ dir: root });

    const path = store.write(tripReport());

    expect(path).not.toContain(':');
    expect(path?.endsWith(REPORT_SUFFIX)).toBe(true);
  });

  it('swallows a failed write, reports it out of band and returns undefined', () => {
    // `writeReport` runs inside the guarded path, at the moment a call is being
    // refused. A throw here turns a clean refusal the agent can read into a
    // JSON-RPC error — exactly the failure the refusal exists to prevent.
    const failures: unknown[] = [];
    const blocked = join(root, 'read-only');
    mkdirSync(blocked);
    chmodSync(blocked, 0o500);
    const store = new FileReportStore({
      dir: join(blocked, 'reports'),
      onError: (error) => failures.push(error),
    });

    const path = store.write(tripReport());

    chmodSync(blocked, 0o700);
    expect(path).toBeUndefined();
    expect(store.failed).toBe(1);
    expect(store.written).toBe(0);
    expect(failures).toHaveLength(1);
  });

  it('survives a failed write with no error reporter at all', () => {
    const blocked = join(root, 'ro');
    mkdirSync(blocked);
    chmodSync(blocked, 0o500);
    const store = new FileReportStore({ dir: join(blocked, 'reports') });

    expect(store.write(tripReport())).toBeUndefined();

    chmodSync(blocked, 0o700);
  });
});

describe('the writeReport hook the proxy takes', () => {
  it('writes the decision`s report and hands back the path', () => {
    const store = new FileReportStore({ dir: root });
    const decision = {
      action: 'deny',
      reasons: [],
      wouldTrip: false,
      callId: 'CALL1',
      report: tripReport(),
    } satisfies Decision;

    const path = store.hook(decision);

    expect(path).toBe(store.list()[0]?.path);
  });

  it('writes nothing for a decision that carries no report', () => {
    // An `onDecision` hook that raised the action produces a block the engine
    // built no report for. There is nothing to write and nothing to report.
    const store = new FileReportStore({ dir: root });

    const path = store.hook({ action: 'deny', reasons: [], wouldTrip: false, callId: 'C' });

    expect(path).toBeUndefined();
    expect(store.written).toBe(0);
  });
});

describe('FileReportStore.list', () => {
  it('is empty for a directory that does not exist, which is a fact and not an error', () => {
    const store = new FileReportStore({ dir: join(root, 'never-written') });

    expect(store.list()).toEqual([]);
    expect(store.last()).toBeUndefined();
  });

  it('ignores files that are not reports', () => {
    const store = new FileReportStore({ dir: root });
    store.write(tripReport());
    writeFileSync(join(root, 'notes.txt'), 'hello', 'utf8');
    writeFileSync(join(root, '.DS_Store'), '', 'utf8');

    expect(store.list()).toHaveLength(1);
  });

  it('reads the trip id and the timestamp back out of the filename', () => {
    const store = new FileReportStore({ dir: root });
    const report = tripReport({ at: 0, tripId: 'TRIPX' });
    store.write(report);

    const entry = store.last();

    expect(entry?.tripId).toBe('TRIPX');
    // Not ISO-8601: `:` and `.` were replaced to keep the name portable.
    expect(entry?.stamp).toBe(report.trippedAt.replace(/[:.]/g, '-'));
    expect(entry?.file).toBe(`${entry?.stamp}__TRIPX.json`);
  });

  it('copes with a report file that was not named by this store', () => {
    const store = new FileReportStore({ dir: root });
    writeFileSync(join(root, 'hand-written.json'), '{}', 'utf8');

    const entry = store.last();

    expect(entry?.tripId).toBe('hand-written');
    expect(entry?.stamp).toBe('');
  });
});

describe('FileReportStore.find', () => {
  it('finds by trip id, filename and path', () => {
    const store = new FileReportStore({ dir: root });
    store.write(tripReport({ at: 0, tripId: 'FINDME' }));
    const entry = store.last() as NonNullable<ReturnType<FileReportStore['last']>>;

    expect(store.find('FINDME')).toEqual(entry);
    expect(store.find(entry.file)).toEqual(entry);
    expect(store.find(entry.path)).toEqual(entry);
  });

  it('resolves a relative path against the store, not the process working directory', () => {
    const store = new FileReportStore({ dir: root });
    store.write(tripReport({ at: 0, tripId: 'RELATIVE' }));
    const entry = store.last() as NonNullable<ReturnType<FileReportStore['last']>>;

    expect(store.find(`./${entry.file}`)).toEqual(entry);
  });

  it('says where it looked when nothing matches', () => {
    const store = new FileReportStore({ dir: root });
    store.write(tripReport());

    try {
      store.find('NOPE');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const hints = (error as CliError).hints.join(' ');
      expect(hints).toContain(root);
      expect(hints).toContain('agentfuse report list');
    }
  });

  it('says the directory is empty when it is, rather than suggesting a listing', () => {
    const store = new FileReportStore({ dir: root });

    try {
      store.find('NOPE');
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as CliError).hints.join(' ')).toContain('nothing has tripped');
    }
  });
});

describe('FileReportStore.read', () => {
  it('round-trips a report it wrote', () => {
    const store = new FileReportStore({ dir: root });
    const report = tripReport();
    const path = store.write(report) as string;

    expect(store.read(path)).toEqual(report);
  });

  it('rejects a file that is not there', () => {
    const store = new FileReportStore({ dir: root });

    expect(() => store.read(join(root, 'gone.json'))).toThrow(/cannot read the report/);
  });

  it('rejects a file that is not JSON', () => {
    const store = new FileReportStore({ dir: root });
    const path = join(root, 'broken.json');
    writeFileSync(path, '{ not json', 'utf8');

    expect(() => store.read(path)).toThrow(/is not valid JSON/);
  });

  it('rejects JSON that is not a trip report', () => {
    // The directory is on the user's disk and may hold a report from a newer
    // AgentFuse; rendering one of those with this renderer would produce
    // confident nonsense.
    const store = new FileReportStore({ dir: root });
    const path = join(root, 'other.json');
    writeFileSync(path, JSON.stringify({ kind: 'trip', reportVersion: 2 }), 'utf8');

    expect(() => store.read(path)).toThrow(/is not an AgentFuse trip report/);
  });
});

describe('isTripReport', () => {
  it('accepts what core builds', () => {
    expect(isTripReport(tripReport())).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'trip'],
    ['an empty object', {}],
    [
      'a future report version',
      { kind: 'trip', reportVersion: 2, tripId: 'a', sessionId: 'b', trippedAt: 'c' },
    ],
    [
      'another kind of document',
      { kind: 'session', reportVersion: 1, tripId: 'a', sessionId: 'b', trippedAt: 'c' },
    ],
    ['a report with no id', { kind: 'trip', reportVersion: 1, sessionId: 'b', trippedAt: 'c' }],
    ['a report with no session', { kind: 'trip', reportVersion: 1, tripId: 'a', trippedAt: 'c' }],
    ['a report with no timestamp', { kind: 'trip', reportVersion: 1, tripId: 'a', sessionId: 'b' }],
  ])('rejects %s', (_label, value) => {
    expect(isTripReport(value)).toBe(false);
  });
});
