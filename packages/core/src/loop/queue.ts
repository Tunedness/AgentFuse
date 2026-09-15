/**
 * The bounded asynchronous embedding queue.
 *
 * ADR-002: *"Embedding hesabı kritik yolda değil, asenkron kuyruktadır; kesme
 * kararı bir sonraki çağrıda uygulanır."* — the embedding work is not on the
 * critical path, it is on an asynchronous queue, and the breaking decision is
 * applied on the next call.
 *
 * Everything in this file exists to honour that sentence. A tool call is
 * forwarded the instant the guards say so; the text to embed is dropped into
 * this queue and the caller never waits. The p95 budget for AgentFuse's added
 * latency is 50 ms (PRD §6) and an ONNX forward pass does not fit in it.
 *
 * Four consequences follow, and all four are deliberate:
 *
 * - **The queue is bounded and sheds load.** An agent can produce tool calls
 *   faster than a model can embed them. Growing without limit would turn a
 *   latency problem into a memory problem, so the queue holds 64 jobs and drops
 *   the **oldest** when it overflows. Oldest, because the semantic rule scores
 *   the *current* window: a call from thirty calls ago has already fallen out of
 *   the window it would have been scored in, so embedding it buys nothing.
 * - **Every drop is reported.** A session whose calls were not all scored is
 *   marked degraded, so a trip report can admit reduced fidelity instead of
 *   quietly implying it scored everything.
 * - **Failure is contained here.** A provider that rejects or throws must
 *   degrade AgentFuse to rule-only detection; it must never fail a tool call or
 *   take the proxy down. The batch is dropped, a retry delay is armed, and the
 *   worker keeps serving.
 * - **Nothing here starts a timer.** Core has no clock of its own beyond the
 *   injected {@link Clock} — the same reason the engine makes the approval
 *   gateway own its timeout instead of arming one itself. So the retry delay
 *   after a failed batch is a deadline compared against `clock.now()`, and the
 *   thing that wakes the worker up again is the next {@link
 *   EmbeddingQueue.enqueue}. That is the right trigger anyway: this queue only
 *   matters while calls are flowing, and a backlog nobody is adding to belongs
 *   to a window that has already moved on.
 */

import type { Clock, EmbeddingProvider } from '../ports/index.js';

/** The minimum a queued job has to carry. Detectors extend it. */
export interface EmbeddingJob {
  /** Whose session this call belongs to; used to report load shedding. */
  sessionId: string;
  /** The text to embed. */
  text: string;
}

/** Why a job was thrown away. */
export type DropCause = 'overflow' | 'sampling';

/** Counters a caller can read to find out how honest the scoring has been. */
export interface EmbeddingQueueStats {
  /** Jobs offered to {@link EmbeddingQueue.enqueue}. */
  offered: number;
  /** Jobs handed to {@link EmbeddingQueueOptions.onEmbedded}. */
  embedded: number;
  /** Jobs dropped because the queue was full. */
  droppedOverflow: number;
  /** Jobs dropped because the queue was shedding load. */
  droppedSampling: number;
  /** Successful `embed()` calls. */
  batches: number;
  /** Failed `embed()` calls, plus vectors the consumer refused. */
  failures: number;
  /** Whether the queue is currently sampling rather than scoring everything. */
  sampling: boolean;
  /** EWMA of observed batch latency, in milliseconds. */
  latencyMsEwma: number;
  /** Jobs waiting. */
  depth: number;
}

/** Construction options for {@link EmbeddingQueue}. */
export interface EmbeddingQueueOptions<J extends EmbeddingJob> {
  provider: EmbeddingProvider;
  clock: Clock;
  /**
   * Receives every successfully embedded job. Must not throw; one that does is
   * contained and counted as a failure.
   */
  onEmbedded: (job: J, vector: Float32Array) => void;
  /** Receives every job the queue threw away. */
  onDropped?: (job: J, cause: DropCause) => void;
  /**
   * Receives every contained failure.
   *
   * Not routed through `TelemetrySink`: umbrella ADR-003 fixes the event schema
   * at four types, none of which describes "the embedding backend is unwell",
   * and inventing a fifth — or dressing this up as a `loop_detection` event —
   * would poison a schema shared with McpGuard. The counters in
   * {@link EmbeddingQueueStats} carry the same information in a form a host can
   * log however it likes.
   */
  onFailure?: (error: unknown, jobs: readonly J[]) => void;
  /** Maximum jobs waiting. Default 64. */
  capacity?: number;
  /** Maximum texts per `embed()` call. Default 8. */
  batchSize?: number;
  /** Projected backlog above which the queue starts sampling. Default 2000 ms. */
  backlogBudgetMs?: number;
  /** First retry delay after a failed batch. Default 50 ms. */
  retryDelayMs?: number;
  /** Ceiling for the exponential retry delay. Default 2000 ms. */
  maxRetryDelayMs?: number;
}

const DEFAULT_CAPACITY = 64;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_BACKLOG_BUDGET_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_MAX_RETRY_DELAY_MS = 2_000;

/**
 * Weight of the newest latency measurement in the EWMA.
 *
 * High enough that the queue reacts to a model that has just gone slow within a
 * handful of batches, low enough that one unlucky garbage collection does not
 * convince it to start shedding load.
 */
const LATENCY_ALPHA = 0.3;

/** A single-worker, bounded, batching embedding queue. */
export class EmbeddingQueue<J extends EmbeddingJob = EmbeddingJob> {
  readonly #provider: EmbeddingProvider;
  readonly #clock: Clock;
  readonly #onEmbedded: (job: J, vector: Float32Array) => void;
  readonly #onDropped: ((job: J, cause: DropCause) => void) | undefined;
  readonly #onFailure: ((error: unknown, jobs: readonly J[]) => void) | undefined;
  readonly #capacity: number;
  readonly #batchSize: number;
  readonly #backlogBudgetMs: number;
  readonly #retryDelayMs: number;
  readonly #maxRetryDelayMs: number;

  readonly #queue: J[] = [];
  #running: Promise<void> | undefined;
  #closed = false;
  #failureStreak = 0;
  /** `clock.now()` before which the worker refuses to start. */
  #retryAfter = 0;
  #sampleTick = 0;
  #latency = 0;

  #offered = 0;
  #embedded = 0;
  #droppedOverflow = 0;
  #droppedSampling = 0;
  #batches = 0;
  #failures = 0;

  constructor(options: EmbeddingQueueOptions<J>) {
    this.#provider = options.provider;
    this.#clock = options.clock;
    this.#onEmbedded = options.onEmbedded;
    this.#onDropped = options.onDropped;
    this.#onFailure = options.onFailure;
    this.#capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.#batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.#backlogBudgetMs = options.backlogBudgetMs ?? DEFAULT_BACKLOG_BUDGET_MS;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  }

  /** Jobs waiting to be embedded. */
  get depth(): number {
    return this.#queue.length;
  }

  /** True once the projected backlog exceeds the budget. */
  get sampling(): boolean {
    return this.#projectedBacklogMs() > this.#backlogBudgetMs;
  }

  /** True while a failed batch's retry delay has not yet elapsed. */
  get backingOff(): boolean {
    return this.#clock.now() < this.#retryAfter;
  }

  /** A snapshot of the counters. */
  get stats(): EmbeddingQueueStats {
    return {
      offered: this.#offered,
      embedded: this.#embedded,
      droppedOverflow: this.#droppedOverflow,
      droppedSampling: this.#droppedSampling,
      batches: this.#batches,
      failures: this.#failures,
      sampling: this.sampling,
      latencyMsEwma: this.#latency,
      depth: this.#queue.length,
    };
  }

  /**
   * Offers a job. Returns whether it was accepted.
   *
   * Synchronous and allocation-light by design: this runs from `afterCall`, on
   * the proxy's response path, and it must add nothing measurable to it. The
   * worker is started but never awaited.
   */
  enqueue(job: J): boolean {
    if (this.#closed) return false;
    this.#offered += 1;

    if (this.#shouldShed()) {
      this.#drop(job, 'sampling');
      return false;
    }

    this.#queue.push(job);

    // Trim from the front: the oldest waiting job is the one whose window has
    // already moved on without it.
    while (this.#queue.length > this.#capacity) {
      const evicted = this.#queue.shift();
      if (evicted !== undefined) this.#drop(evicted, 'overflow');
    }

    this.#pump();
    return true;
  }

  /**
   * Runs the worker until the queue is empty.
   *
   * Returns `false` when it could not get there — the queue is closed, or a
   * failed batch's retry delay has not elapsed on the injected clock. There is
   * no wall-clock timeout because there is no wall clock here: a caller that
   * wants a backed-off queue to try again advances the clock and calls back.
   */
  async drain(): Promise<boolean> {
    for (;;) {
      const running = this.#running;
      if (running !== undefined) {
        await running;
        continue;
      }
      if (this.#queue.length === 0) return true;
      this.#pump();
      // `#pump` declined: closed, or still inside a retry delay. Either way no
      // further progress is possible without the caller doing something.
      if (this.#running === undefined) return false;
    }
  }

  /**
   * Stops accepting work, waits for the batch in flight, and releases the
   * provider.
   *
   * Does **not** drain: anything still queued is discarded. A caller that wants
   * the backlog scored calls {@link drain} first, and one that is shutting down
   * a stuck proxy very much does not.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;

    const running = this.#running;
    if (running !== undefined) await running;

    try {
      await this.#provider.close?.();
    } catch (error) {
      // A provider that cannot close cleanly is not a reason to fail a shutdown
      // that is already under way.
      this.#failures += 1;
      this.#onFailure?.(error, []);
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Adaptive sampling: under backlog, admit every second offer.
   *
   * The trigger is the *projected* backlog — the measured per-batch latency
   * times the number of batches waiting — rather than raw depth, because a
   * depth of 40 means nothing until you know whether a batch takes one
   * millisecond or one second. Above the budget the queue admits half the
   * offers, which halves the arrival rate at the cost of a sparser window; the
   * sessions affected are marked degraded so the sparseness is on the record.
   */
  #shouldShed(): boolean {
    if (!this.sampling) {
      this.#sampleTick = 0;
      return false;
    }
    this.#sampleTick += 1;
    // Keeps the first offer after the backlog is detected, drops the second,
    // and alternates from there.
    return this.#sampleTick % 2 === 0;
  }

  #projectedBacklogMs(): number {
    if (this.#latency === 0) return 0;
    return this.#latency * Math.ceil(this.#queue.length / this.#batchSize);
  }

  #drop(job: J, cause: DropCause): void {
    if (cause === 'overflow') this.#droppedOverflow += 1;
    else this.#droppedSampling += 1;
    this.#onDropped?.(job, cause);
  }

  #pump(): void {
    if (this.#running !== undefined || this.#closed || this.#queue.length === 0) return;
    if (this.backingOff) return;
    const run = this.#run();
    this.#running = run;
    void run.then(() => {
      this.#running = undefined;
      // A job that arrived between the loop's last check and this callback
      // would otherwise sit unembedded until the next `enqueue`.
      this.#pump();
    });
  }

  /** The worker. Never rejects: every failure mode is handled inside. */
  async #run(): Promise<void> {
    while (this.#queue.length > 0 && !this.#closed && !this.backingOff) {
      const batch = this.#queue.splice(0, this.#batchSize);
      const started = this.#clock.now();

      let vectors: Float32Array[];
      try {
        vectors = await this.#provider.embed(batch.map((job) => job.text));
      } catch (error) {
        this.#failures += 1;
        this.#failureStreak += 1;
        this.#retryAfter = this.#clock.now() + this.#retryDelay();
        this.#onFailure?.(error, batch);
        // The batch is gone. Re-queuing it would keep a broken provider busy
        // failing the same texts while the window they belonged to moves on.
        continue;
      }

      this.#failureStreak = 0;
      this.#retryAfter = 0;
      this.#batches += 1;
      this.#observeLatency(this.#clock.now() - started);

      for (let i = 0; i < batch.length; i += 1) {
        const job = batch[i];
        const vector = vectors[i];
        // A provider that returns fewer vectors than texts is broken, but it is
        // not going to break the session over it.
        if (job === undefined || vector === undefined) {
          this.#failures += 1;
          continue;
        }
        try {
          this.#onEmbedded(job, vector);
          this.#embedded += 1;
        } catch (error) {
          this.#failures += 1;
          this.#onFailure?.(error, [job]);
        }
      }
    }
  }

  #retryDelay(): number {
    const exponent = Math.min(this.#failureStreak - 1, 20);
    return Math.min(this.#maxRetryDelayMs, this.#retryDelayMs * 2 ** exponent);
  }

  #observeLatency(measured: number): void {
    const sample = Math.max(0, measured);
    this.#latency =
      this.#latency === 0 ? sample : LATENCY_ALPHA * sample + (1 - LATENCY_ALPHA) * this.#latency;
  }
}
