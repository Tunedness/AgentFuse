import { describe, expect, it } from 'vitest';
import { FakeClock } from '../adapters/clock.js';
import type { EmbeddingProvider } from '../ports/index.js';
import { type DropCause, type EmbeddingJob, EmbeddingQueue } from './queue.js';

/**
 * The queue is where the "never block a tool call" promise is actually kept, so
 * these tests are mostly about what happens when things go wrong: the backlog
 * outruns the model, the provider rejects, the provider throws, the provider
 * lies about how many vectors it produced, the consumer throws. In every one of
 * those cases the queue has to stay up and keep serving.
 *
 * Time comes from a {@link FakeClock} throughout. The queue starts no timers,
 * so the whole file runs without sleeping and a retry delay is exercised by
 * advancing a number.
 */

/** A provider whose behaviour each test dictates. */
class TestProvider implements EmbeddingProvider {
  readonly id = 'test:queue';
  readonly dims = 4;
  /** Texts handed to each `embed()` call, in order. */
  readonly calls: string[][] = [];
  /** Milliseconds the fake clock advances while a batch is "running". */
  latencyMs = 0;
  mode: 'ok' | 'reject' | 'throw' | 'gate' = 'ok';
  /** Returns one vector fewer than it was given texts. */
  omitLastVector = false;
  closeCalls = 0;
  closeError: Error | undefined;

  readonly #clock: FakeClock;
  readonly #gates: Array<() => void> = [];

  constructor(clock: FakeClock) {
    this.#clock = clock;
  }

  /** Not `async`: a synchronous throw is a distinct failure path worth testing. */
  embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    if (this.mode === 'throw') throw new Error('provider exploded');
    if (this.mode === 'reject') return Promise.reject(new Error('provider rejected'));
    const produce = (): Float32Array[] => {
      this.#clock.advance(this.latencyMs);
      const vectors = texts.map((text) => unit(text));
      return this.omitLastVector ? vectors.slice(0, -1) : vectors;
    };
    if (this.mode === 'gate') {
      return new Promise((resolve) => {
        this.#gates.push(() => resolve(produce()));
      });
    }
    return Promise.resolve(produce());
  }

  /** Lets one gated batch finish. Returns whether there was one. */
  release(): boolean {
    const gate = this.#gates.shift();
    gate?.();
    return gate !== undefined;
  }

  get gated(): number {
    return this.#gates.length;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
  }
}

/** A deterministic unit vector, enough to tell one job's result from another's. */
function unit(text: string): Float32Array {
  const out = new Float32Array(4);
  let hash = 7;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  out[Math.abs(hash) % 4] = 1;
  return out;
}

interface Harness {
  queue: EmbeddingQueue<EmbeddingJob>;
  provider: TestProvider;
  clock: FakeClock;
  embedded: string[];
  dropped: Array<[string, DropCause]>;
  failures: unknown[];
}

function harness(
  options: Partial<Parameters<typeof makeQueue>[0]> = {},
  onEmbeddedThrows = false,
): Harness {
  const clock = new FakeClock();
  const provider = new TestProvider(clock);
  const embedded: string[] = [];
  const dropped: Array<[string, DropCause]> = [];
  const failures: unknown[] = [];

  const queue = makeQueue({
    provider,
    clock,
    onEmbedded: (job) => {
      if (onEmbeddedThrows) throw new Error('consumer refused');
      embedded.push(job.text);
    },
    onDropped: (job, cause) => dropped.push([job.text, cause]),
    onFailure: (error) => failures.push(error),
    ...options,
  });

  return { queue, provider, clock, embedded, dropped, failures };
}

function makeQueue(
  options: ConstructorParameters<typeof EmbeddingQueue<EmbeddingJob>>[0],
): EmbeddingQueue<EmbeddingJob> {
  return new EmbeddingQueue<EmbeddingJob>(options);
}

function job(text: string, sessionId = 's1'): EmbeddingJob {
  return { sessionId, text };
}

describe('EmbeddingQueue — the happy path', () => {
  it('embeds what it is given and hands the vectors back', async () => {
    const h = harness();
    expect(h.queue.enqueue(job('one'))).toBe(true);
    h.queue.enqueue(job('two'));

    expect(await h.queue.drain()).toBe(true);
    expect(h.embedded).toEqual(['one', 'two']);
    expect(h.queue.stats.embedded).toBe(2);
    expect(h.queue.depth).toBe(0);
  });

  it('draining an empty queue succeeds immediately', async () => {
    const h = harness();
    expect(await h.queue.drain()).toBe(true);
    expect(h.provider.calls).toEqual([]);
  });

  it('batches at most batchSize texts per embed call', async () => {
    // Gated so everything piles up before the first batch is taken, which is
    // the only way to observe the batching from outside.
    const h = harness({ batchSize: 3 });
    h.provider.mode = 'gate';
    for (let i = 0; i < 7; i += 1) h.queue.enqueue(job(`t${i}`));

    h.provider.mode = 'ok';
    while (h.provider.release()) {
      /* let the gated batches through */
    }
    expect(await h.queue.drain()).toBe(true);

    // The first batch is short because the worker starts on the first offer and
    // takes whatever is there — one job. Everything after it piles up behind
    // the gate and goes out in full batches.
    expect(h.provider.calls.map((batch) => batch.length)).toEqual([1, 3, 3]);
    expect(h.embedded).toHaveLength(7);
  });

  it('picks work up again after the queue has gone idle', async () => {
    const h = harness();
    h.queue.enqueue(job('first'));
    expect(await h.queue.drain()).toBe(true);
    h.queue.enqueue(job('second'));
    expect(await h.queue.drain()).toBe(true);
    expect(h.embedded).toEqual(['first', 'second']);
  });

  it('measures batch latency as an EWMA', async () => {
    const h = harness();
    h.provider.latencyMs = 100;
    h.queue.enqueue(job('a'));
    await h.queue.drain();
    expect(h.queue.stats.latencyMsEwma).toBe(100);

    h.provider.latencyMs = 200;
    h.queue.enqueue(job('b'));
    await h.queue.drain();
    // 0.3 * 200 + 0.7 * 100
    expect(h.queue.stats.latencyMsEwma).toBeCloseTo(130, 6);
  });
});

describe('EmbeddingQueue — overflow', () => {
  it('drops the oldest jobs and keeps the recent window', async () => {
    const h = harness({ capacity: 4, batchSize: 2 });
    h.provider.mode = 'gate';
    // t0 goes straight into the gated worker; t1..t9 queue up behind it and the
    // queue keeps only the newest four of them.
    for (let i = 0; i < 10; i += 1) h.queue.enqueue(job(`t${i}`));

    expect(h.queue.depth).toBe(4);
    expect(h.dropped.map(([text]) => text)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(h.dropped.every(([, cause]) => cause === 'overflow')).toBe(true);
    expect(h.queue.stats.droppedOverflow).toBe(5);

    h.provider.mode = 'ok';
    while (h.provider.release()) {
      /* drain the gate */
    }
    expect(await h.queue.drain()).toBe(true);
    expect(h.embedded).toEqual(['t0', 't6', 't7', 't8', 't9']);
  });

  it('never rejects an offer for lack of room — it makes room', () => {
    const h = harness({ capacity: 2 });
    h.provider.mode = 'gate';
    for (let i = 0; i < 20; i += 1) expect(h.queue.enqueue(job(`t${i}`))).toBe(true);
    expect(h.queue.depth).toBe(2);
    // One batch in flight, one worker: the bound is on what waits, not on how
    // much work the single worker is allowed to have taken.
    expect(h.provider.gated).toBe(1);
  });
});

describe('EmbeddingQueue — adaptive sampling', () => {
  it('sheds every second offer once the projected backlog exceeds the budget', async () => {
    const h = harness({ batchSize: 2, capacity: 64, backlogBudgetMs: 150 });

    // One completed batch, so there is a measured latency to project with.
    h.provider.latencyMs = 200;
    h.queue.enqueue(job('warmup'));
    await h.queue.drain();
    expect(h.queue.stats.latencyMsEwma).toBe(200);
    expect(h.queue.sampling).toBe(false);

    // Now stall the worker and build a backlog: one queued batch at 200 ms
    // already exceeds the 150 ms budget.
    h.provider.mode = 'gate';
    for (let i = 0; i < 8; i += 1) h.queue.enqueue(job(`t${i}`));

    expect(h.queue.sampling).toBe(true);
    expect(h.queue.stats.droppedSampling).toBeGreaterThan(0);
    expect(h.dropped.every(([, cause]) => cause === 'sampling')).toBe(true);
    // Half admitted, half shed — the arrival rate is halved, not stopped.
    expect(h.queue.stats.droppedSampling).toBeLessThan(8);
  });

  it('stops sampling once the backlog clears', async () => {
    const h = harness({ batchSize: 1, backlogBudgetMs: 50 });
    h.provider.latencyMs = 500;
    h.queue.enqueue(job('warmup'));
    await h.queue.drain();

    h.provider.mode = 'gate';
    h.queue.enqueue(job('a'));
    h.queue.enqueue(job('b'));
    expect(h.queue.sampling).toBe(true);

    h.provider.mode = 'ok';
    while (h.provider.release()) {
      /* drain the gate */
    }
    await h.queue.drain();
    expect(h.queue.sampling).toBe(false);
  });

  it('does not sample before it has measured anything', () => {
    const h = harness({ backlogBudgetMs: 0 });
    h.provider.mode = 'gate';
    for (let i = 0; i < 20; i += 1) h.queue.enqueue(job(`t${i}`));
    expect(h.queue.stats.droppedSampling).toBe(0);
  });
});

describe('EmbeddingQueue — a provider that fails', () => {
  it('contains a rejection, counts it, and keeps serving', async () => {
    const h = harness();
    h.provider.mode = 'reject';
    h.queue.enqueue(job('doomed'));

    // The batch is gone rather than re-queued, so the queue really is empty;
    // what the failure leaves behind is an armed retry delay.
    expect(await h.queue.drain()).toBe(true);
    expect(h.failures).toHaveLength(1);
    expect(h.queue.stats.failures).toBe(1);
    expect(h.embedded).toEqual([]);
    expect(h.queue.backingOff).toBe(true);

    h.clock.advance(1_000);
    h.provider.mode = 'ok';
    h.queue.enqueue(job('fine'));
    expect(await h.queue.drain()).toBe(true);
    expect(h.embedded).toEqual(['fine']);
  });

  it('contains a synchronous throw the same way', async () => {
    const h = harness();
    h.provider.mode = 'throw';
    h.queue.enqueue(job('doomed'));
    expect(await h.queue.drain()).toBe(true);
    expect(h.failures).toHaveLength(1);
    expect(h.queue.backingOff).toBe(true);
  });

  it('refuses to start the worker while the retry delay stands', async () => {
    const h = harness({ retryDelayMs: 100 });
    h.provider.mode = 'reject';
    h.queue.enqueue(job('a'));
    await h.queue.drain();

    h.provider.mode = 'ok';
    h.clock.advance(50);
    h.queue.enqueue(job('b'));
    expect(h.queue.depth).toBe(1);
    expect(await h.queue.drain()).toBe(false);
    expect(h.embedded).toEqual([]);

    h.clock.advance(60);
    expect(await h.queue.drain()).toBe(true);
    expect(h.embedded).toEqual(['b']);
  });

  it('backs off exponentially up to the ceiling', async () => {
    const h = harness({ retryDelayMs: 10, maxRetryDelayMs: 40 });
    h.provider.mode = 'reject';
    const armed: number[] = [];

    for (let attempt = 0; attempt < 5; attempt += 1) {
      h.queue.enqueue(job(`t${attempt}`));
      await h.queue.drain();
      const before = h.clock.now();
      // Walk the clock forward until the worker is willing again, and record
      // how far that was.
      let waited = 0;
      while (h.queue.backingOff) {
        h.clock.advance(1);
        waited += 1;
      }
      armed.push(waited);
      expect(h.clock.now()).toBe(before + waited);
    }

    expect(armed).toEqual([10, 20, 40, 40, 40]);
  });

  it('resets the backoff after a batch succeeds', async () => {
    const h = harness({ retryDelayMs: 10 });
    h.provider.mode = 'reject';
    h.queue.enqueue(job('a'));
    await h.queue.drain();
    h.clock.advance(100);

    h.provider.mode = 'ok';
    h.queue.enqueue(job('b'));
    await h.queue.drain();
    expect(h.queue.backingOff).toBe(false);

    h.provider.mode = 'reject';
    h.queue.enqueue(job('c'));
    await h.queue.drain();
    // Back to the first delay, not the doubled one.
    h.clock.advance(10);
    expect(h.queue.backingOff).toBe(false);
  });

  it('counts the vectors a provider failed to return and delivers the rest', async () => {
    const h = harness({ batchSize: 4 });
    h.provider.omitLastVector = true;
    h.provider.mode = 'gate';
    h.queue.enqueue(job('a')); // taken alone, so its only vector is the missing one
    h.queue.enqueue(job('b'));
    h.queue.enqueue(job('c'));

    h.provider.mode = 'ok';
    h.provider.release();
    expect(await h.queue.drain()).toBe(true);

    expect(h.embedded).toEqual(['b']);
    expect(h.queue.stats.failures).toBe(2);
    // A short batch is still an answer, so no retry delay is armed.
    expect(h.queue.backingOff).toBe(false);
  });

  it('contains a consumer that throws', async () => {
    const h = harness({}, true);
    h.queue.enqueue(job('a'));
    expect(await h.queue.drain()).toBe(true);
    expect(h.queue.stats.failures).toBe(1);
    expect(h.queue.stats.embedded).toBe(0);
    expect(h.failures).toHaveLength(1);
  });
});

describe('EmbeddingQueue — shutdown', () => {
  it('discards the backlog, waits for the batch in flight, and closes the provider', async () => {
    const h = harness({ batchSize: 1 });
    h.provider.mode = 'gate';
    h.queue.enqueue(job('inflight'));
    h.queue.enqueue(job('discarded'));

    h.provider.mode = 'ok';
    const closing = h.queue.close();
    h.provider.release();
    await closing;

    expect(h.embedded).toEqual(['inflight']);
    expect(h.provider.closeCalls).toBe(1);
    expect(h.queue.depth).toBe(0);
  });

  it('refuses further work once closed', async () => {
    const h = harness();
    await h.queue.close();
    expect(h.queue.enqueue(job('late'))).toBe(false);
    expect(h.queue.stats.offered).toBe(0);
    expect(await h.queue.drain()).toBe(true);
  });

  it('closes only once', async () => {
    const h = harness();
    await h.queue.close();
    await h.queue.close();
    expect(h.provider.closeCalls).toBe(1);
  });

  it('contains a provider that cannot close', async () => {
    const h = harness();
    h.provider.closeError = new Error('close failed');
    await expect(h.queue.close()).resolves.toBeUndefined();
    expect(h.failures).toHaveLength(1);
  });

  it('tolerates a provider with no close at all', async () => {
    const clock = new FakeClock();
    const provider: EmbeddingProvider = {
      id: 'test:minimal',
      dims: 2,
      embed: async (texts) => texts.map(() => new Float32Array([1, 0])),
    };
    const queue = makeQueue({ provider, clock, onEmbedded: () => undefined });
    queue.enqueue(job('a'));
    await queue.drain();
    await expect(queue.close()).resolves.toBeUndefined();
  });
});
