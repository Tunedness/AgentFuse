import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_PREFIX, Diagnostics } from './diagnostics.js';

/** A sink that records what was written, standing in for stderr. */
class RecordingSink {
  readonly lines: string[] = [];

  write(chunk: string): void {
    this.lines.push(chunk);
  }
}

/** A clock the test moves by hand, so the rate limiter needs no real time. */
function manualClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe('Diagnostics', () => {
  it('writes a prefixed JSON line to the sink it was given', () => {
    const sink = new RecordingSink();
    new Diagnostics({ sink }).emit('trip', { code: 'LOOP_SEMANTIC' });

    expect(sink.lines).toEqual([`${DIAGNOSTIC_PREFIX} {"event":"trip","code":"LOOP_SEMANTIC"}\n`]);
  });

  it('emits an event with no fields', () => {
    const sink = new RecordingSink();
    new Diagnostics({ sink }).emit('started');

    expect(sink.lines[0]).toBe(`${DIAGNOSTIC_PREFIX} {"event":"started"}\n`);
  });

  it('writes nothing at all when quiet', () => {
    const sink = new RecordingSink();
    const diagnostics = new Diagnostics({ sink, quiet: true });
    diagnostics.emit('trip');

    expect(diagnostics.enabled).toBe(false);
    expect(sink.lines).toEqual([]);
  });

  it('reports itself enabled by default', () => {
    expect(new Diagnostics({ sink: new RecordingSink() }).enabled).toBe(true);
  });

  it('describes an unserializable payload instead of throwing', () => {
    const sink = new RecordingSink();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    new Diagnostics({ sink }).emit('trip', { cyclic });

    expect(sink.lines[0]).toBe(`${DIAGNOSTIC_PREFIX} {"event":"trip","unserializable":true}\n`);
  });

  it('caps the number of lines per window', () => {
    const sink = new RecordingSink();
    const clock = manualClock();
    const diagnostics = new Diagnostics({ sink, maxPerWindow: 3, now: clock.now });

    for (let index = 0; index < 10; index += 1) diagnostics.emit('trip', { index });

    // A breaker tripping on every call in a tight loop must not bury the
    // wrapped server's own stderr under AgentFuse's.
    expect(sink.lines).toHaveLength(3);
  });

  it('reports how many lines it suppressed once the window rolls', () => {
    const sink = new RecordingSink();
    const clock = manualClock();
    const diagnostics = new Diagnostics({ sink, maxPerWindow: 2, windowMs: 1_000, now: clock.now });

    for (let index = 0; index < 5; index += 1) diagnostics.emit('trip', { index });
    clock.advance(1_000);
    diagnostics.emit('after');

    expect(sink.lines).toHaveLength(4);
    expect(sink.lines[2]).toBe(
      `${DIAGNOSTIC_PREFIX} {"event":"diagnostics_suppressed","dropped":3}\n`,
    );
    expect(sink.lines[3]).toContain('"event":"after"');
  });

  it('counts the suppression notice against the new window’s budget', () => {
    const sink = new RecordingSink();
    const clock = manualClock();
    const diagnostics = new Diagnostics({ sink, maxPerWindow: 1, windowMs: 1_000, now: clock.now });

    diagnostics.emit('a');
    diagnostics.emit('b');
    clock.advance(1_000);
    diagnostics.emit('c');

    // Budget of one, spent on the notice: 'c' is itself suppressed rather than
    // sneaking past the cap on the back of the bookkeeping line.
    expect(sink.lines.map((line) => line.includes('"event":"c"'))).toEqual([false, false]);
    expect(sink.lines[1]).toContain('diagnostics_suppressed');
  });

  it('does not report a suppression notice when nothing was suppressed', () => {
    const sink = new RecordingSink();
    const clock = manualClock();
    const diagnostics = new Diagnostics({ sink, windowMs: 1_000, now: clock.now });

    diagnostics.emit('a');
    clock.advance(5_000);
    diagnostics.emit('b');

    expect(sink.lines).toHaveLength(2);
    expect(sink.lines.some((line) => line.includes('diagnostics_suppressed'))).toBe(false);
  });

  it('starts its window at construction, not at the epoch', () => {
    const sink = new RecordingSink();
    const clock = manualClock(5_000_000);
    const diagnostics = new Diagnostics({ sink, maxPerWindow: 2, now: clock.now });

    diagnostics.emit('a');
    diagnostics.emit('b');
    diagnostics.emit('c');

    // A window anchored at 0 would have rolled on the very first emit and made
    // the cap unobservable for the first second of every process.
    expect(sink.lines).toHaveLength(2);
  });
});
