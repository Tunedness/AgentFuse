import { describe, expect, it } from 'vitest';
import { DenyAllApprovalGateway, ScriptedApprovalGateway } from './approval.js';
import { FakeClock, SystemClock } from './clock.js';
import { InMemorySessionStore } from './session-store.js';
import { NoopTelemetrySink, RecordingTelemetrySink } from './telemetry.js';
import { HeuristicTokenizer, TableCostModel } from './tokenizer.js';
import { CounterIdGenerator, UlidGenerator } from './ulid.js';

describe('clocks', () => {
  it('reads the wall clock', () => {
    expect(new SystemClock().now()).toBeGreaterThan(1_700_000_000_000);
  });

  it('is hand-cranked in tests', () => {
    const clock = new FakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.advance(500)).toBe(1_500);
    clock.set(9);
    expect(clock.now()).toBe(9);
  });
});

describe('UlidGenerator', () => {
  const clock = new FakeClock(1_700_000_000_000);

  it('produces 26 Crockford base32 characters', () => {
    const id = new UlidGenerator(clock, (b) => b.fill(0)).next();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts lexicographically by time', () => {
    const local = new FakeClock(1_700_000_000_000);
    const ids = new UlidGenerator(local, (b) => b.fill(0));
    const first = ids.next();
    local.advance(1);
    expect(ids.next() > first).toBe(true);
  });

  it('stays monotonic inside a single millisecond', () => {
    const ids = new UlidGenerator(clock, (b) => b.fill(0));
    const minted = [ids.next(), ids.next(), ids.next()];
    expect([...minted].sort()).toEqual(minted);
    expect(new Set(minted).size).toBe(3);
  });

  it('redraws rather than wrapping when the random field overflows', () => {
    let draws = 0;
    const ids = new UlidGenerator(clock, (b) => {
      draws += 1;
      b.fill(0xff);
    });
    ids.next();
    ids.next();
    expect(draws).toBe(2);
  });

  it('defaults to the platform RNG', () => {
    const ids = new UlidGenerator(clock);
    expect(ids.next()).not.toBe(ids.next());
  });

  it('refuses a timestamp it cannot encode', () => {
    expect(() => new UlidGenerator(new FakeClock(-1)).next()).toThrow(RangeError);
  });
});

describe('CounterIdGenerator', () => {
  it('counts, and pads to a ULID width', () => {
    const ids = new CounterIdGenerator();
    expect(ids.next()).toHaveLength(26);
    expect(ids.next().endsWith('2')).toBe(true);
  });

  it('accepts a custom prefix', () => {
    expect(new CounterIdGenerator('AB').next().startsWith('AB')).toBe(true);
  });
});

describe('InMemorySessionStore', () => {
  it('creates, touches, lists and deletes', () => {
    const store = new InMemorySessionStore();
    const state = store.create('s', 100);
    expect(store.get('s')).toBe(state);
    store.touch(state, 350);
    expect(state.counters.durationMs).toBe(250);
    expect([...store.all()]).toEqual([state]);
    store.delete('s');
    expect(store.get('s')).toBeUndefined();
  });

  it('sweeps only what has actually gone quiet', () => {
    const store = new InMemorySessionStore();
    store.create('idle', 0);
    const busy = store.create('busy', 0);
    store.touch(busy, 900);
    expect(store.sweepIdle(1_000, 1_000)).toEqual(['idle']);
    expect(store.get('busy')).toBeDefined();
  });
});

describe('HeuristicTokenizer', () => {
  it('estimates one token per four bytes', () => {
    const tokenizer = new HeuristicTokenizer();
    expect(tokenizer.count('')).toBe(0);
    expect(tokenizer.count('abcd')).toBe(1);
    expect(tokenizer.count('abcde')).toBe(2);
    // Multi-byte characters cost what they cost on the wire.
    expect(tokenizer.count('é')).toBe(1);
  });
});

describe('TableCostModel', () => {
  it('prices input and output separately', () => {
    const cost = new TableCostModel({ inputPerMTokUsd: 3, outputPerMTokUsd: 15 });
    expect(cost.estimateUsd({ input: 1_000_000, output: 1_000_000 })).toBeCloseTo(18);
    expect(cost.estimateUsd({ input: 0, output: 0 })).toBe(0);
  });
});

describe('telemetry sinks', () => {
  it('drops everything by default', async () => {
    const sink = new NoopTelemetrySink();
    expect(() => sink.emit()).not.toThrow();
    await expect(sink.shutdown()).resolves.toBeUndefined();
  });

  it('records and narrows by type', async () => {
    const sink = new RecordingTelemetrySink();
    sink.emit({ type: 'tool_call' } as never);
    sink.emit({ type: 'budget_event' } as never);
    expect(sink.ofType('tool_call')).toHaveLength(1);
    await expect(sink.shutdown()).resolves.toBeUndefined();
  });
});

describe('approval gateways', () => {
  it('denies when nobody is there to ask', async () => {
    await expect(new DenyAllApprovalGateway().requestApproval()).resolves.toBe('denied');
  });

  it('replays a script and then falls back', async () => {
    const gateway = new ScriptedApprovalGateway(['approved', 'denied'], 'timeout');
    const request = {
      approvalId: 'a',
      sessionId: 's',
      toolName: 't',
      serverName: 'v',
      argsPreview: '{}',
      reasons: [],
      timeoutMs: 1,
    };
    expect(await gateway.requestApproval(request)).toBe('approved');
    expect(await gateway.requestApproval(request)).toBe('denied');
    expect(await gateway.requestApproval(request)).toBe('timeout');
    expect(gateway.requests).toHaveLength(3);
  });

  it('repeats a single scripted verdict forever', async () => {
    const gateway = new ScriptedApprovalGateway('approved');
    const request = {
      approvalId: 'a',
      sessionId: 's',
      toolName: 't',
      serverName: 'v',
      argsPreview: '{}',
      reasons: [],
      timeoutMs: 1,
    };
    expect(await gateway.requestApproval(request)).toBe('approved');
    expect(await gateway.requestApproval(request)).toBe('approved');
  });
});
