import { describe, expect, it } from 'vitest';
import { FakeClock } from '../adapters/clock.js';
import { CounterIdGenerator } from '../adapters/ulid.js';
import { FuseEngine } from '../engine.js';
import { parsePolicy } from '../policy/compile.js';
import { renderTripReport } from './render.js';
import type { TripReport } from './trip-report.js';

const SESSION = '01SESSION';

interface Built {
  report: TripReport;
  engine: FuseEngine;
  clock: FakeClock;
}

/**
 * Drives the engine into acceptance scenario A and returns the trip report.
 *
 * The clock and the id generator are fake, so both the JSON and the rendered
 * text are byte-stable and safe to snapshot.
 */
async function tripped(document: Record<string, unknown> = {}): Promise<Built> {
  const clock = new FakeClock(1_757_944_982_000);
  const engine = new FuseEngine(parsePolicy({ version: 1, mode: 'enforce', ...document }), {
    clock,
    ids: new CounterIdGenerator(),
  });

  let report: TripReport | undefined;
  for (let i = 0; i < 3; i += 1) {
    const decision = await engine.beforeCall({
      sessionId: SESSION,
      serverName: 'fs',
      toolName: 'read_file',
      args: { path: '/etc/hosts' },
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    clock.advance(1_000);
    if (decision.action === 'deny') {
      report = decision.report;
      break;
    }
    engine.afterCall(decision.callId, {
      isError: false,
      resultSummary: '127.0.0.1 localhost',
      resultBytes: 512,
    });
    clock.advance(20_000);
  }

  if (!report) throw new Error('expected a trip');
  return { report, engine, clock };
}

/** The policy hash changes whenever the schema does; that is not this snapshot's job. */
function scrub(value: string): string {
  return value
    .replace(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g, '<sha256>')
    .replace(/(?<![0-9a-f])[0-9a-f]{12}(?![0-9a-f])/g, '<sha12>');
}

describe('trip report', () => {
  it('builds the documented shape', async () => {
    const { report } = await tripped();
    expect(JSON.parse(scrub(JSON.stringify(report, null, 2)))).toMatchSnapshot();
  });

  it('carries a policy hash and the inbound traceparent', async () => {
    const { report } = await tripped();
    expect(report.policy.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  });

  it('includes the call that tripped the breaker, still in flight', async () => {
    const { report } = await tripped();
    expect(report.recentCalls).toHaveLength(3);
    expect(report.recentCalls.at(-1)?.durationMs).toBe(0);
  });

  it('honours report.recent_calls', async () => {
    const { report } = await tripped({ report: { recent_calls: 2 } });
    expect(report.recentCalls).toHaveLength(2);
  });

  it('replaces argument previews with fingerprints when redaction is on', async () => {
    const { report } = await tripped({ report: { redact_args: true } });
    for (const call of report.recentCalls) {
      expect(call.argsPreview).toBe(call.fingerprint);
    }
  });

  it('omits traceparent when the request did not carry one', async () => {
    const clock = new FakeClock();
    const engine = new FuseEngine(parsePolicy({ version: 1, mode: 'enforce' }), {
      clock,
      ids: new CounterIdGenerator(),
    });
    let report: TripReport | undefined;
    for (let i = 0; i < 3; i += 1) {
      const decision = await engine.beforeCall({
        sessionId: SESSION,
        serverName: 'fs',
        toolName: 'read_file',
        args: {},
      });
      if (decision.action === 'deny') report = decision.report;
      else engine.afterCall(decision.callId, { isError: false, resultSummary: '', resultBytes: 0 });
    }
    expect(report?.traceparent).toBeUndefined();
  });
});

describe('renderTripReport', () => {
  it('renders a compact terminal view', async () => {
    const { report } = await tripped();
    expect(scrub(renderTripReport(report))).toMatchSnapshot();
  });

  it('stays under 25 lines for a typical trip', async () => {
    const { report } = await tripped();
    expect(renderTripReport(report).split('\n').length).toBeLessThanOrEqual(25);
  });

  it('collapses consecutive identical calls into a repeat glyph', async () => {
    const { report } = await tripped();
    expect(renderTripReport(report)).toContain('×2');
  });

  it('shows the error signature instead of arguments for a failed call', async () => {
    const { report } = await tripped();
    const [first] = report.recentCalls;
    if (!first) throw new Error('expected a call');
    const withError: TripReport = {
      ...report,
      recentCalls: [
        { ...first, isError: true, errorSignature: 'code:ENOENT' },
        ...report.recentCalls.slice(1),
      ],
    };
    const text = renderTripReport(withError);
    expect(text).toContain('code:ENOENT');
    expect(text).toContain('ERR');
  });

  it('elides older call groups rather than growing without bound', async () => {
    const { report } = await tripped();
    const [first] = report.recentCalls;
    if (!first) throw new Error('expected a call');
    const many: TripReport = {
      ...report,
      recentCalls: Array.from({ length: 30 }, (_, i) => ({
        ...first,
        id: `call-${i}`,
        fingerprint: `fingerprint-${i}`,
      })),
    };
    const text = renderTripReport(many);
    expect(text).toContain('earlier call group(s) omitted');
  });

  it('does not divide by zero when a limit is absent', async () => {
    const { report } = await tripped();
    const zeroed: TripReport = {
      ...report,
      budgets: {
        ...report.budgets,
        limits: { durationMs: 0, calls: 0, tokensEstimated: 0, usdEstimated: 0 },
      },
    };
    expect(renderTripReport(zeroed)).toContain('  0%');
  });

  it('says what the human answered and why', async () => {
    // ADR-009: the report is an audit artifact, and the first thing an audit
    // asks of a human-gated call is why the person answered as they did.
    const { report } = await tripped();
    const answered: TripReport = {
      ...report,
      approval: { verdict: 'approved', reason: 'the retry is intentional, I asked for it' },
    };

    const text = renderTripReport(answered);

    expect(text).toContain('human: approved');
    expect(text).toContain('the retry is intentional, I asked for it');
  });

  it('says nothing about approval when nobody was asked', async () => {
    const { report } = await tripped();

    expect(renderTripReport(report)).not.toContain('human:');
  });

  it('renders a verdict that came with no words', async () => {
    const { report } = await tripped();
    const answered: TripReport = { ...report, approval: { verdict: 'timeout' } };

    expect(renderTripReport(answered)).toContain('human: timeout');
  });

  it('cannot be broken apart by the reason, however it was written', async () => {
    // The text arrives sanitised from the engine, so the worst a report can be
    // handed is a long run of ordinary words. It wraps; it does not overflow
    // the ruled table or introduce a line that is not ours.
    const { report } = await tripped();
    const answered: TripReport = {
      ...report,
      approval: { verdict: 'denied', reason: 'no '.repeat(200).trim() },
    };

    const lines = renderTripReport(answered).split('\n');
    const reasonLines = lines.filter((line) => line.startsWith('    no'));

    expect(reasonLines.length).toBeGreaterThan(2);
    expect(reasonLines.every((line) => line.length <= 78)).toBe(true);
    // The sections after it are still where they were.
    expect(lines.some((line) => line.startsWith('  recent calls'))).toBe(true);
    expect(lines.at(-1)).toContain('agentfuse ');
  });

  it('wraps a long trigger message', async () => {
    const { report } = await tripped();
    const wordy: TripReport = {
      ...report,
      trigger: { ...report.trigger, message: 'word '.repeat(60).trim() },
    };
    expect(
      renderTripReport(wordy)
        .split('\n')
        .filter((l) => l.startsWith('  word')).length,
    ).toBeGreaterThan(2);
  });
});
