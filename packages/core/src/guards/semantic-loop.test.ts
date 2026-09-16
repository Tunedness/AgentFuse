import { describe, expect, it } from 'vitest';
import { FakeClock } from '../adapters/clock.js';
import { RecordingTelemetrySink } from '../adapters/telemetry.js';
import { CounterIdGenerator } from '../adapters/ulid.js';
import type { CallOutcome, Decision, TripCode } from '../domain/index.js';
import { FuseEngine } from '../engine.js';
import { HashingProvider } from '../loop/hashing-provider.js';
import { parsePolicy } from '../policy/compile.js';
import type { EmbeddingProvider } from '../ports/index.js';
import { attachSemanticLoopDetector, SemanticLoopDetector } from './semantic-loop.js';

/**
 * The semantic layer, driven through the real engine.
 *
 * Two properties matter more than any other here and each has its own test:
 * the verdict lands on call **N+1** and never on N (ADR-002), and nothing this
 * layer does can fail a tool call — not an overflowing queue, not a provider
 * that rejects every batch.
 *
 * All of it runs on {@link HashingProvider}, so the whole path is exercised
 * without installing the ~301 MB ONNX runtime that ADR-003 moved into an
 * optional package.
 */

const SESSION = 'session-1';

interface Harness {
  engine: FuseEngine;
  detector: SemanticLoopDetector;
  clock: FakeClock;
  telemetry: RecordingTelemetrySink;
}

interface HarnessOptions {
  document?: Record<string, unknown>;
  provider?: EmbeddingProvider;
  capacity?: number;
  batchSize?: number;
  backlogBudgetMs?: number;
  maxSessions?: number;
}

function harness(options: HarnessOptions = {}): Harness {
  const clock = new FakeClock();
  const telemetry = new RecordingTelemetrySink();
  const engine = new FuseEngine(parsePolicy({ version: 1, ...options.document }), {
    clock,
    ids: new CounterIdGenerator(),
    telemetry,
  });
  const detector = attachSemanticLoopDetector({
    host: engine,
    provider: options.provider ?? new HashingProvider(128),
    clock,
    telemetry,
    ...(options.capacity !== undefined ? { capacity: options.capacity } : undefined),
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : undefined),
    ...(options.backlogBudgetMs !== undefined
      ? { backlogBudgetMs: options.backlogBudgetMs }
      : undefined),
    ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : undefined),
  });
  return { engine, detector, clock, telemetry };
}

const OK: CallOutcome = { isError: false, resultSummary: 'still not fixed', resultBytes: 15 };

/**
 * One call, end to end, without draining the embedding queue.
 *
 * Deliberately separate from {@link scoredCall}: a test that proves the verdict
 * cannot land on the call that caused it has to be able to run a call while the
 * queue is still holding the evidence.
 */
async function call(
  h: Harness,
  args: unknown,
  options: { tool?: string; sessionId?: string; outcome?: CallOutcome } = {},
): Promise<Decision> {
  const decision = await h.engine.beforeCall({
    sessionId: options.sessionId ?? SESSION,
    serverName: 'fs',
    toolName: options.tool ?? 'write_file',
    args,
  });
  h.clock.advance(5);
  if (decision.action !== 'deny') h.engine.afterCall(decision.callId, options.outcome ?? OK);
  return decision;
}

/** One call, then everything the queue is holding. */
async function scoredCall(
  h: Harness,
  args: unknown,
  options: Parameters<typeof call>[2] = {},
): Promise<Decision> {
  const decision = await call(h, args, options);
  await h.detector.drain();
  return decision;
}

/**
 * Arguments that are almost the same piece of work but never the *same* call.
 *
 * Distinct fingerprints, so exact-repeat cannot fire; all distinct, so the
 * A-B-A-B cycle rule cannot fire; no errors, so error-repeat cannot fire. The
 * only rule left that can object is the semantic one, which is the point.
 */
function attempt(n: number): Record<string, unknown> {
  return { path: '/src/parser.ts', note: `retry attempt number ${n}` };
}

/** An agent doing seven unrelated things. The negative case for the whole rule. */
const VARIED: ReadonlyArray<readonly [string, unknown]> = [
  ['read_file', { path: '/src/index.ts' }],
  ['query', { sql: 'SELECT id, total FROM invoices LIMIT 20' }],
  ['create_pull_request', { title: 'Extract the tokenizer', base: 'main' }],
  ['send_email', { to: 'ops@example.com', subject: 'deploy finished' }],
  ['list_buckets', { region: 'eu-central-1' }],
  ['render_chart', { series: [3, 9, 27], kind: 'bar' }],
  ['compile', { target: 'wasm32-unknown-unknown', release: true }],
];

function codes(decision: Decision): TripCode[] {
  return decision.reasons.map((reason) => reason.code);
}

/** A provider that never produces a vector. */
class BrokenProvider implements EmbeddingProvider {
  readonly id = 'test:broken';
  readonly dims = 16;
  calls = 0;

  embed(): Promise<Float32Array[]> {
    this.calls += 1;
    return Promise.reject(new Error('embedding backend is down'));
  }
}

/** A provider whose batches only finish when a test says so. */
class GatedProvider implements EmbeddingProvider {
  readonly id = 'test:gated';
  readonly dims = 16;
  readonly #inner = new HashingProvider(16);
  readonly #gates: Array<() => void> = [];

  embed(texts: string[]): Promise<Float32Array[]> {
    return new Promise((resolve) => {
      this.#gates.push(() => resolve(texts.map((text) => this.#inner.vector(text))));
    });
  }

  release(): boolean {
    const gate = this.#gates.shift();
    gate?.();
    return gate !== undefined;
  }

  get holding(): number {
    return this.#gates.length;
  }
}

/**
 * Lets a gated provider finish everything, one batch at a time.
 *
 * Each release lets the worker take the next batch, which needs a microtask
 * turn before it exists, so this alternates rather than releasing in a burst.
 * Bounded, so a mistake here fails instead of hanging the suite.
 */
async function flush(h: Harness, provider: GatedProvider): Promise<void> {
  for (let i = 0; i < 64; i += 1) {
    provider.release();
    await Promise.resolve();
    if (provider.holding === 0 && h.detector.stats.depth === 0) return;
  }
  throw new Error('the gated queue would not finish');
}

describe('the semantic rule trips on the next call, never on this one', () => {
  it('leaves the verdict behind and lets the call that produced it through', async () => {
    const h = harness({ document: { mode: 'enforce' } });

    // Calls 1..4 cannot score at all: the default `min_calls` is 5.
    for (let n = 1; n <= 4; n += 1) {
      const decision = await scoredCall(h, attempt(n));
      expect(decision.action).toBe('allow');
      expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip).toBeUndefined();
    }

    // Call 5 fills the window and scores above the threshold. Under the
    // calibrated `consecutive_windows: 1` that is already a verdict — but it is
    // still allowed, because the evidence for it only exists after it
    // completed. That is the whole property this test is named for.
    const fifth = await scoredCall(h, attempt(5));
    expect(fifth.action).toBe('allow');
    expect(fifth.report).toBeUndefined();
    expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip?.code).toBe('LOOP_SEMANTIC');

    // Call 6 pays for it.
    const sixth = await scoredCall(h, attempt(6));
    expect(sixth.action).toBe('deny');
    expect(codes(sixth)).toEqual(['LOOP_SEMANTIC']);
    expect(sixth.report?.trigger.code).toBe('LOOP_SEMANTIC');
    expect(h.engine.ports.sessions.get(SESSION)?.breaker.phase).toBe('open');
    expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip).toBeUndefined();
  });

  it('cannot trip the call whose own embedding is still queued', async () => {
    // A provider that finishes nothing until this test says so, which is the
    // strongest form of the property: no amount of evidence still inside the
    // queue can affect the call that produced it.
    const provider = new GatedProvider();
    const h = harness({ document: { mode: 'enforce' }, provider });

    for (let n = 1; n <= 8; n += 1) {
      expect((await call(h, attempt(n))).action).toBe('allow');
    }
    expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip).toBeUndefined();
    expect(h.detector.stats.embedded).toBe(0);

    await flush(h, provider);
    expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip?.code).toBe('LOOP_SEMANTIC');
    expect((await call(h, attempt(9))).action).toBe('deny');
  });

  it('reports the score, the threshold and the calls it looked at', async () => {
    const h = harness({ document: { mode: 'enforce' } });
    for (let n = 1; n <= 5; n += 1) await scoredCall(h, attempt(n));

    const reason = h.engine.ports.sessions.get(SESSION)?.pendingTrip;
    const evidence = reason?.evidence as Record<string, unknown>;
    expect(evidence.threshold).toBe(0.905);
    expect(evidence.consecutiveWindows).toBe(1);
    expect(evidence.minCalls).toBe(5);
    expect(evidence.model).toBe('test:hashing-trigram-128');
    expect(evidence.score as number).toBeGreaterThan(0.905);
    expect(evidence.callIds).toHaveLength(5);
    expect(evidence.fingerprints).toHaveLength(5);
    // The message has to tell the agent to stop rather than to try again.
    expect(reason?.message).toContain('Stop');
  });

  it('emits a loop_detection event carrying the window score', async () => {
    const h = harness({ document: { mode: 'enforce' } });
    for (let n = 1; n <= 5; n += 1) await scoredCall(h, attempt(n));

    const events = h.telemetry.ofType('loop_detection');
    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe('LOOP_SEMANTIC');
    expect(events[0]?.windowScore as number).toBeGreaterThan(0.905);
    expect(events[0]?.enforced).toBe(true);
    expect(events[0]?.timestamp).toBe(h.clock.now());
  });

  it('does not immediately trip again on the history that just tripped it', async () => {
    const h = harness({ document: { mode: 'enforce' } });
    for (let n = 1; n <= 5; n += 1) await scoredCall(h, attempt(n));
    await scoredCall(h, attempt(6));
    expect(h.engine.ports.sessions.get(SESSION)?.breaker.phase).toBe('open');

    // Operator resets; the window the detector held is gone too, so it needs
    // `min_calls` fresh evidence before it can object again.
    h.engine.resetBreaker(SESSION);
    for (let n = 8; n <= 11; n += 1) {
      await scoredCall(h, attempt(n));
      expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip).toBeUndefined();
    }
    expect(h.detector.stats.trips).toBe(1);
  });
});

describe('consecutive windows', () => {
  it('does not trip on a single threshold crossing', async () => {
    // `consecutive_windows: 4` with only enough similar calls for three
    // windows: the streak never gets there.
    const h = harness({
      document: {
        mode: 'enforce',
        loop_detection: { min_calls: 3, semantic: { consecutive_windows: 4 } },
      },
    });
    for (let n = 1; n <= 5; n += 1) await scoredCall(h, attempt(n));
    expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip).toBeUndefined();
    expect(h.detector.stats.trips).toBe(0);
  });

  it('resets the streak when a window drops back below the threshold', async () => {
    // `consecutive_windows: 2`, above the calibrated default of 1, because the
    // streak is only observable when more than one crossing is needed.
    const h = harness({
      document: { mode: 'enforce', loop_detection: { semantic: { consecutive_windows: 2 } } },
    });
    for (let n = 1; n <= 5; n += 1) await scoredCall(h, attempt(n));
    expect(h.detector.lastScore(SESSION) as number).toBeGreaterThan(0.905);

    // One genuinely different piece of work drags the mean back down and the
    // streak restarts from zero — which is exactly what stops an agent that is
    // making progress from being punished for a burst of similar calls.
    await scoredCall(
      h,
      { sql: 'SELECT count(*) FROM orders WHERE status = 42' },
      {
        tool: 'query',
      },
    );
    expect(h.detector.lastScore(SESSION) as number).toBeLessThan(0.905);
    expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip).toBeUndefined();
  });

  it('never fires on genuinely varied work', async () => {
    const h = harness({ document: { mode: 'enforce' } });
    for (const [tool, args] of VARIED) {
      const decision = await scoredCall(h, args, { tool });
      expect(decision.action).toBe('allow');
    }
    expect(h.detector.stats.trips).toBe(0);
    expect(h.detector.lastScore(SESSION) as number).toBeLessThan(0.905);
  });
});

describe('warn mode', () => {
  it('reports wouldTrip and still forwards the call', async () => {
    // `warn` is the default, and it is how a user measures their own
    // false-positive rate before switching enforcement on.
    const h = harness();
    for (let n = 1; n <= 5; n += 1) await scoredCall(h, attempt(n));
    expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip?.code).toBe('LOOP_SEMANTIC');

    const sixth = await scoredCall(h, attempt(6));
    expect(sixth.action).toBe('warn');
    expect(sixth.wouldTrip).toBe(true);
    expect(codes(sixth)).toEqual(['LOOP_SEMANTIC']);
    // A report is still produced: warn mode observes everything enforce mode
    // would have done.
    expect(sixth.report?.trigger.code).toBe('LOOP_SEMANTIC');
    expect(sixth.report?.mode).toBe('warn');

    // And the call went through, so the session keeps accumulating.
    expect(h.engine.ports.sessions.get(SESSION)?.counters.calls).toBe(6);
  });

  it('records that enforcement did not follow', async () => {
    const h = harness();
    for (let n = 1; n <= 6; n += 1) await scoredCall(h, attempt(n));
    expect(h.telemetry.ofType('loop_detection')[0]?.enforced).toBe(false);
  });
});

describe('the semantic rule can be switched off', () => {
  it('skips a call whose rule disables it', async () => {
    const h = harness({ document: { loop_detection: { semantic: { enabled: false } } } });
    for (let n = 1; n <= 6; n += 1) await scoredCall(h, attempt(n));
    expect(h.detector.stats.skipped).toBe(6);
    expect(h.detector.stats.offered).toBe(0);
    expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip).toBeUndefined();
  });

  it('treats provider: none as off', async () => {
    const h = harness({ document: { loop_detection: { semantic: { provider: 'none' } } } });
    await scoredCall(h, attempt(1));
    expect(h.detector.stats.skipped).toBe(1);
  });

  it('honours a per-rule override', async () => {
    const h = harness({
      document: {
        tools: [
          {
            match: 'fs__write_file',
            action: 'allow',
            loop_detection: { semantic: { enabled: false } },
          },
          { match: '*', action: 'allow' },
        ],
      },
    });
    await scoredCall(h, attempt(1));
    await scoredCall(h, attempt(2), { tool: 'read_file' });
    expect(h.detector.stats.skipped).toBe(1);
    expect(h.detector.stats.offered).toBe(1);
  });

  it('resizes an existing window when a rule asks for a narrower one', async () => {
    // The global rule tolerates a very long streak, so nothing trips while the
    // window is wide. The per-tool rule wants a window of four and trips on two
    // consecutive crossings.
    const h = harness({
      document: {
        mode: 'enforce',
        loop_detection: { window: 8, min_calls: 4, semantic: { consecutive_windows: 50 } },
        tools: [
          {
            match: 'fs__read_file',
            action: 'allow',
            loop_detection: { window: 4, semantic: { consecutive_windows: 2 } },
          },
          { match: '*', action: 'allow' },
        ],
      },
    });

    for (let n = 1; n <= 6; n += 1) await scoredCall(h, attempt(n));
    expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip).toBeUndefined();

    // Switching to the narrower rule keeps the history already paid for, minus
    // what no longer fits — so the trip evidence names four calls, not seven.
    await scoredCall(h, attempt(7), { tool: 'read_file' });
    const evidence = h.engine.ports.sessions.get(SESSION)?.pendingTrip?.evidence as Record<
      string,
      unknown
    >;
    expect(evidence.windowSize).toBe(4);
    expect(evidence.callIds).toHaveLength(4);
  });
});

describe('a provider that fails', () => {
  it('leaves the engine working on rule-only detection', async () => {
    const provider = new BrokenProvider();
    const h = harness({ document: { mode: 'enforce' }, provider });

    // Six similar calls. Every batch rejects; not one call is affected.
    for (let n = 1; n <= 6; n += 1) {
      const decision = await scoredCall(h, attempt(n));
      expect(decision.action).toBe('allow');
      // The clock advances 5 ms per call, so the retry delay expires and the
      // worker keeps trying rather than silently giving up.
    }
    expect(provider.calls).toBeGreaterThan(0);
    expect(h.detector.stats.failures).toBeGreaterThan(0);
    expect(h.detector.stats.embedded).toBe(0);
    expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip).toBeUndefined();

    // The session is honest about what happened: nothing was scored, which is
    // worse than having been sampled.
    expect(h.engine.ports.sessions.get(SESSION)?.degraded).toBe('unavailable');

    // And the deterministic tier is untouched — three identical calls still
    // break the circuit on the third.
    for (let i = 0; i < 2; i += 1) {
      expect((await scoredCall(h, { path: '/same' })).action).toBe('allow');
    }
    const third = await scoredCall(h, { path: '/same' });
    expect(third.action).toBe('deny');
    expect(codes(third)).toContain('LOOP_EXACT_REPEAT');
  });

  it('contains a provider that throws synchronously', async () => {
    const provider: EmbeddingProvider = {
      id: 'test:throws',
      dims: 8,
      embed(): Promise<Float32Array[]> {
        throw new Error('synchronous explosion');
      },
    };
    const h = harness({ provider });
    await expect(scoredCall(h, attempt(1))).resolves.toMatchObject({ action: 'allow' });
    expect(h.detector.stats.failures).toBe(1);
  });

  it('keeps unavailable once it is set, even if sampling follows', async () => {
    const provider = new BrokenProvider();
    const h = harness({ provider });
    await scoredCall(h, attempt(1));
    expect(h.engine.ports.sessions.get(SESSION)?.degraded).toBe('unavailable');
    h.engine.markDegraded(SESSION, 'sampled');
    expect(h.engine.ports.sessions.get(SESSION)?.degraded).toBe('unavailable');
  });
});

describe('a queue that overflows', () => {
  it('marks the session sampled without dropping it or failing a call', async () => {
    const provider = new GatedProvider();
    const h = harness({ provider, capacity: 2, batchSize: 1 });

    for (let n = 1; n <= 12; n += 1) {
      const decision = await call(h, attempt(n));
      expect(decision.action).toBe('allow');
    }

    expect(h.detector.stats.droppedOverflow).toBeGreaterThan(0);
    expect(h.engine.ports.sessions.get(SESSION)?.degraded).toBe('sampled');

    // Nothing about the session was lost: every call was counted and the
    // circuit is still closed.
    expect(h.engine.ports.sessions.get(SESSION)?.counters.calls).toBe(12);
    expect(h.engine.ports.sessions.get(SESSION)?.breaker.phase).toBe('closed');

    await flush(h, provider);
    const summary = h.engine.endSession(SESSION);
    expect(summary.degraded).toBe(true);
    expect(summary.calls).toBe(12);
  });
});

describe('the detector bookkeeping', () => {
  it('scores sessions independently', async () => {
    const h = harness({ document: { mode: 'enforce' } });
    for (let n = 0; n < 5; n += 1) {
      await scoredCall(h, attempt(n));
      const [tool, args] = VARIED[n] as [string, unknown];
      await scoredCall(h, args, { tool, sessionId: 'session-2' });
    }
    // One session looping and one session working, through the same detector.
    expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip?.code).toBe('LOOP_SEMANTIC');
    expect(h.engine.ports.sessions.get('session-2')?.pendingTrip).toBeUndefined();
    expect(h.detector.stats.sessions).toBe(2);
  });

  it('forgets a session on request', async () => {
    const h = harness();
    await scoredCall(h, attempt(1));
    expect(h.detector.stats.sessions).toBe(1);
    h.detector.forget(SESSION);
    expect(h.detector.stats.sessions).toBe(0);
    expect(h.detector.lastScore(SESSION)).toBeUndefined();
  });

  it('bounds how many sessions it tracks', async () => {
    // Without a bound this map would grow for the lifetime of the proxy: the
    // detector never sees a session being swept out of the store.
    const h = harness({ maxSessions: 3 });
    for (let i = 0; i < 6; i += 1) {
      await scoredCall(h, attempt(i), { sessionId: `s${i}` });
    }
    expect(h.detector.stats.sessions).toBe(3);
    // The oldest are the ones that went.
    expect(h.detector.lastScore('s0')).toBeUndefined();
  });

  it('is idempotent about attaching', async () => {
    const h = harness();
    h.detector.attach();
    await scoredCall(h, attempt(1));
    expect(h.detector.stats.offered).toBe(1);
  });

  it('releases the provider on close', async () => {
    let closed = 0;
    const provider: EmbeddingProvider = {
      id: 'test:closeable',
      dims: 4,
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
      close: async () => {
        closed += 1;
      },
    };
    const h = harness({ provider });
    await scoredCall(h, attempt(1));
    await h.detector.close();
    expect(closed).toBe(1);
    expect(h.detector.stats.sessions).toBe(0);
  });

  it('can be built without attaching and driven by hand', () => {
    const clock = new FakeClock();
    const engine = new FuseEngine(parsePolicy({ version: 1 }), { clock });
    const detector = new SemanticLoopDetector({
      host: engine,
      provider: new HashingProvider(16),
      clock,
    });
    // Nothing subscribed, so a completed call reaches the detector only if a
    // caller hands it over.
    expect(detector.stats.offered).toBe(0);
  });
});

/**
 * The answer axis, added in phase 9.
 *
 * The window score is `min(similarity, staleness)`, and these tests drive the
 * two apart with a provider that reports perfect similarity for everything.
 * That is the only way to see the gate on its own: with a real embedder, a
 * changing answer moves both numbers at once, and a test that could not tell
 * them apart would pass whether or not the gate existed.
 *
 * The measurement that forced this: on similarity alone, a `search_issues`
 * pagination pair scored 0.9971 while a genuine reworded retry scored 0.9791 —
 * the two sit on the wrong side of each other, so no threshold separates them.
 */
describe('the semantic rule also asks whether the answers moved', () => {
  /** Every text is the same point, so the similarity axis is pinned at 1. */
  const IDENTICAL: EmbeddingProvider = {
    id: 'test:identical',
    dims: 4,
    embed: (texts) => Promise.resolve(texts.map(() => new Float32Array([1, 0, 0, 0]))),
  };

  const answered = (text: string): CallOutcome => ({
    isError: false,
    resultSummary: text,
    resultBytes: text.length,
  });

  it('trips when the answers repeat', async () => {
    const h = harness({ document: { mode: 'enforce' }, provider: IDENTICAL });
    // Five calls fill the window and score above the threshold; the sixth
    // consumes the verdict.
    for (let n = 1; n <= 5; n += 1) {
      await scoredCall(h, attempt(n), { outcome: answered('No issues matched the query.') });
    }
    expect(h.detector.lastScore(SESSION)).toBe(1);
    expect(codes(await call(h, attempt(6)))).toContain('LOOP_SEMANTIC');
  });

  it('holds its fire through a pagination sweep', async () => {
    // Identical vectors, so the similarity axis says "loop" as loudly as it
    // can. Only the answers disagree, and they are enough.
    const h = harness({ document: { mode: 'enforce' }, provider: IDENTICAL });
    for (let n = 1; n <= 12; n += 1) {
      await scoredCall(h, attempt(n), {
        outcome: answered(`issue${n * 7} titled quaver${n} owned by hoopoe${n * 3}`),
      });
    }
    expect(h.detector.lastScore(SESSION)).toBeLessThanOrEqual(0.5);
    expect(codes(await call(h, attempt(99)))).not.toContain('LOOP_SEMANTIC');
    expect((await call(h, attempt(100))).action).toBe('allow');
  });

  it('reports both numbers in the trip evidence', async () => {
    const h = harness({ document: { mode: 'enforce' }, provider: IDENTICAL });
    for (let n = 1; n <= 5; n += 1) {
      await scoredCall(h, attempt(n), { outcome: answered('still nothing') });
    }
    const reason = (await call(h, attempt(6))).reasons.find((r) => r.code === 'LOOP_SEMANTIC');

    expect(reason?.evidence?.similarity).toBe(1);
    expect(reason?.evidence?.staleness).toBe(1);
    expect(reason?.message).toContain('already in one of the other answers');
  });

  it('keeps the two windows the same size when a rule overrides it', async () => {
    // The novelty window is resized in lockstep with the embedding window; if
    // it were not, the two would be describing different windows of calls and
    // the minimum of their scores would mean nothing.
    const h = harness({
      document: {
        mode: 'enforce',
        tools: [
          { match: 'fs__write_file', action: 'allow', loop_detection: { window: 12 } },
          { match: '*', action: 'allow' },
        ],
      },
      provider: IDENTICAL,
    });
    for (let n = 1; n <= 12; n += 1) {
      await scoredCall(h, attempt(n), { outcome: answered('unchanged') });
    }
    expect(h.detector.lastScore(SESSION)).toBe(1);
  });

  it('clears the answers too when it trips', async () => {
    const h = harness({ document: { mode: 'enforce' }, provider: IDENTICAL });
    for (let n = 1; n <= 5; n += 1) {
      await scoredCall(h, attempt(n), { outcome: answered('same again') });
    }
    expect(codes(await call(h, attempt(6)))).toContain('LOOP_SEMANTIC');
    h.engine.resetBreaker(SESSION);

    // The window that tripped it is gone, so nothing is scorable until a new
    // one has been built from scratch.
    await scoredCall(h, attempt(100), { outcome: answered('same again') });
    expect(h.detector.lastScore(SESSION)).toBeUndefined();
  });
});
