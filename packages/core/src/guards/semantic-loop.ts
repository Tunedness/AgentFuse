/**
 * R4 — the semantic loop rule, and the only guard that is not a guard.
 *
 * The other four run inside `beforeCall`, synchronously, and answer before the
 * call is forwarded. This one cannot: ADR-002 puts the embedding computation on
 * an asynchronous queue and applies its verdict *on the next call*, because an
 * ONNX forward pass does not fit in the 50 ms p95 budget from PRD §6. So the
 * shape here is inverted. It subscribes to completed calls, embeds them off the
 * hot path, and when a window converges it leaves a note — `pendingTrip` — for
 * `breakerGuard` to act on the next time that session calls a tool.
 *
 * That costs one extra turn of the loop, which ADR-002 accepts explicitly: a
 * loop caught one call late is far cheaper than a loop not caught at all.
 *
 * **Nothing in here is allowed to fail a tool call.** Every path — a provider
 * that rejects, a queue that overflows, a consumer that throws — degrades
 * AgentFuse to rule-only detection and records that it did. The three
 * deterministic rules in `rule-loop.ts` keep working with no embedding model
 * anywhere in sight, which is what ADR-003 means when it says the rule tier is
 * fully functional without the optional companion package.
 *
 * ## What trips it
 *
 * Two things have to be true at once, and the window score is the **smaller**
 * of them:
 *
 * - **Similarity** — the mean pairwise cosine of the window's embeddings (see
 *   {@link EmbeddingWindow}). The agent keeps asking the same kind of thing.
 * - **Staleness** — the mean fraction of each answer's tokens that another
 *   answer in the window also produced (see {@link ResultNoveltyWindow}). The
 *   agent keeps being told the same thing.
 *
 * Phase 9 added the second one, and the measurement that forced it is worth
 * keeping close: on similarity alone, a `search_issues` pagination sweep scored
 * **higher** than a genuine reworded retry — 0.9971 against 0.9791 in phase 4's
 * own table — because the tool name and the argument shape dominate a
 * concatenated text and the answer is one short line at the end of it. No
 * threshold separates a loop from progress on that axis, at any value; the
 * corpus of 200 labelled sessions put a hard ceiling of about 75% recall on it
 * at a usable false-positive rate. Taking the minimum of the two axes can only
 * ever *narrow* what trips, which is the direction a circuit breaker is allowed
 * to be wrong in.
 *
 * That score has to exceed `semantic.threshold` in
 * `semantic.consecutive_windows` **consecutive** windows. The calibrated
 * default is one, reversing the original guess of two: a similarity-only score
 * spikes, because two similar calls in a row happen constantly in honest work,
 * but the minimum of similarity and staleness moves smoothly as the window
 * slides and does not. Given that, the sweep preferred a higher threshold
 * judged once over a lower one judged twice. Operators who want the extra
 * confirmation still have the knob.
 *
 * `min_calls` gates this rule and only this rule. Phase 2 recorded why: gating
 * the deterministic rules behind it would make "the same call three times →
 * trip on the third" impossible under the default `min_calls: 5`, and that is
 * the single most common thing AgentFuse exists to catch.
 */

import { NoopTelemetrySink } from '../adapters/telemetry.js';
import type { Reason } from '../domain/decision.js';
import type { ToolCallRecord } from '../domain/records.js';
import type { DegradedCause, SessionState } from '../domain/session.js';
import { semanticEmbeddingText, semanticResultText } from '../loop/embed-text.js';
import { shortFingerprint } from '../loop/fingerprint.js';
import { ResultNoveltyWindow } from '../loop/novelty.js';
import { type EmbeddingJob, EmbeddingQueue, type EmbeddingQueueStats } from '../loop/queue.js';
import { EmbeddingWindow } from '../loop/window.js';
import type { CompiledPolicy } from '../policy/compile.js';
import { evaluateRules } from '../policy/evaluate.js';
import type { LoopDetectionSettings } from '../policy/schema.js';
import type { Clock, EmbeddingProvider, TelemetrySink } from '../ports/index.js';

/**
 * The slice of {@link FuseEngine} the detector needs.
 *
 * Expressed as an interface rather than importing the class so the dependency
 * runs one way only: the engine knows nothing about the semantic layer beyond
 * the three seams phase 2 left for it, and this file can be tested against a
 * three-method stub. `FuseEngine` satisfies it structurally.
 */
export interface SemanticHost {
  /** The compiled policy, for resolving the loop settings of each call. */
  readonly policy: CompiledPolicy;
  /** Where the detector subscribes. Called at the end of every `afterCall`. */
  onRecordComplete(listener: (record: ToolCallRecord, session: SessionState) => void): void;
  /** Leaves a verdict for the next call. First writer wins. */
  markPendingTrip(sessionId: string, reason: Reason): void;
  /** Records that this session was not fully scored. */
  markDegraded(sessionId: string, cause?: DegradedCause): void;
}

/** One queued call, plus the settings that were in force when it was made. */
interface SemanticJob extends EmbeddingJob {
  callId: string;
  fingerprint: string;
  /** The answer half of {@link EmbeddingJob.text}, for the novelty window. */
  resultText: string;
  /**
   * The merged loop settings for this call's matched rule.
   *
   * Snapshotted at enqueue time rather than looked up again on the worker: a
   * rule's `loop_detection` override belongs to the call it matched, and by the
   * time the vector comes back the session may be touching a different tool
   * under different settings.
   */
  loop: LoopDetectionSettings;
}

/** Per-session scoring state. */
interface SessionSemantics {
  window: EmbeddingWindow;
  /** The answer side of the same window. Resized and cleared in lockstep. */
  novelty: ResultNoveltyWindow;
  /** The most recent similarity, before it was combined with staleness. */
  lastSimilarity: number | undefined;
  /** The most recent staleness. */
  lastStaleness: number | undefined;
  /** Consecutive windows scored above the threshold. */
  streak: number;
  /** The most recent score, or `undefined` before the window filled. */
  lastScore: number | undefined;
  /** Call ids currently in the window, oldest first, for trip evidence. */
  callIds: string[];
  /** Short fingerprints in the window, oldest first, for trip evidence. */
  prints: string[];
}

/** Construction options for {@link SemanticLoopDetector}. */
export interface SemanticLoopDetectorOptions {
  host: SemanticHost;
  provider: EmbeddingProvider;
  clock: Clock;
  /** Where `loop_detection` events go. Defaults to dropping them. */
  telemetry?: TelemetrySink;
  /** Maximum jobs waiting. Default 64. */
  capacity?: number;
  /** Maximum texts per `embed()` call. Default 8. */
  batchSize?: number;
  /** Projected backlog above which the queue starts sampling. Default 2000 ms. */
  backlogBudgetMs?: number;
  /**
   * Maximum sessions scored at once. Default 1024.
   *
   * A bound rather than a leak: the detector cannot see a session being deleted
   * from the store, so the least recently scored session is forgotten when the
   * limit is reached. A host that knows better calls {@link
   * SemanticLoopDetector.forget} at session end.
   */
  maxSessions?: number;
}

const DEFAULT_MAX_SESSIONS = 1024;

/** Counters for the whole semantic layer. */
export interface SemanticLoopStats extends EmbeddingQueueStats {
  /** Sessions currently being scored. */
  sessions: number;
  /** Verdicts left for `breakerGuard` to pick up. */
  trips: number;
  /** Calls skipped because the semantic rule was off for them. */
  skipped: number;
}

/** The asynchronous semantic loop detector. See the module doc. */
export class SemanticLoopDetector {
  readonly #host: SemanticHost;
  readonly #provider: EmbeddingProvider;
  readonly #clock: Clock;
  readonly #telemetry: TelemetrySink;
  readonly #queue: EmbeddingQueue<SemanticJob>;
  readonly #maxSessions: number;
  /** Insertion-ordered, so the first key is the least recently scored session. */
  readonly #sessions = new Map<string, SessionSemantics>();
  #attached = false;
  #trips = 0;
  #skipped = 0;

  constructor(options: SemanticLoopDetectorOptions) {
    this.#host = options.host;
    this.#provider = options.provider;
    this.#clock = options.clock;
    this.#telemetry = options.telemetry ?? new NoopTelemetrySink();
    this.#maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
    this.#queue = new EmbeddingQueue<SemanticJob>({
      provider: options.provider,
      clock: options.clock,
      onEmbedded: (job, vector) => this.#score(job, vector),
      onDropped: (job) => {
        // Load shedding, not failure: the window is sparser than the policy
        // asked for, and the session summary has to say so.
        this.#host.markDegraded(job.sessionId, 'sampled');
      },
      onFailure: (_error, jobs) => {
        // Nothing was scored for these calls at all. That is a strictly worse
        // state than sampling and is recorded as such.
        for (const job of jobs) this.#host.markDegraded(job.sessionId, 'unavailable');
      },
      ...(options.capacity !== undefined ? { capacity: options.capacity } : undefined),
      ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : undefined),
      ...(options.backlogBudgetMs !== undefined
        ? { backlogBudgetMs: options.backlogBudgetMs }
        : undefined),
    });
  }

  /** Subscribes to the host's completed-call stream. Idempotent. */
  attach(): this {
    if (this.#attached) return this;
    this.#attached = true;
    this.#host.onRecordComplete((record) => this.observe(record));
    return this;
  }

  /** Counters for the whole layer. */
  get stats(): SemanticLoopStats {
    return {
      ...this.#queue.stats,
      sessions: this.#sessions.size,
      trips: this.#trips,
      skipped: this.#skipped,
    };
  }

  /**
   * Offers one completed call for scoring.
   *
   * Synchronous and never throws — it is called at the tail of `afterCall`,
   * which is on the proxy's response path. All it does is build a string and
   * hand it to a bounded queue.
   */
  observe(record: ToolCallRecord): void {
    const loop = evaluateRules(this.#host.policy, record.serverName, record.toolName).loop;
    const semantic = loop.semantic;
    // `provider: 'none'` is how an operator turns the layer off without
    // rewriting the rest of their loop configuration.
    if (!semantic.enabled || semantic.provider === 'none') {
      this.#skipped += 1;
      return;
    }

    this.#queue.enqueue({
      sessionId: record.sessionId,
      callId: record.id,
      fingerprint: record.fingerprint,
      text: semanticEmbeddingText(record),
      resultText: semanticResultText(record),
      loop,
    });
  }

  /**
   * The most recent window score for a session, or `undefined` when it has not
   * been scored yet.
   *
   * Read-only observability rather than control flow: it is what a report shows
   * next to a trip, and what phase 9's threshold sweep reads to build a ROC
   * curve without reaching into private state.
   */
  lastScore(sessionId: string): number | undefined {
    return this.#sessions.get(sessionId)?.lastScore;
  }

  /** Runs the queue to empty. For tests and for an orderly shutdown. */
  drain(): Promise<boolean> {
    return this.#queue.drain();
  }

  /** Drops a session's scoring state. Hosts call this when a session ends. */
  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  /** Stops the queue and releases the provider. */
  async close(): Promise<void> {
    await this.#queue.close();
    this.#sessions.clear();
  }

  // -------------------------------------------------------------------------

  /** Folds one vector into its session's window and decides whether to trip. */
  #score(job: SemanticJob, vector: Float32Array): void {
    const loop = job.loop;
    const state = this.#stateFor(job.sessionId, loop.window);

    state.window.push(vector);
    state.novelty.push(job.resultText);
    state.callIds.push(job.callId);
    state.prints.push(shortFingerprint(job.fingerprint));
    while (state.callIds.length > state.window.capacity) state.callIds.shift();
    while (state.prints.length > state.window.capacity) state.prints.shift();

    const similarity = state.window.score(loop.min_calls);
    const staleness = state.novelty.staleness(loop.min_calls);
    state.lastSimilarity = similarity ?? undefined;
    state.lastStaleness = staleness ?? undefined;
    // The two windows are pushed together and gated by the same `min_calls`, so
    // they answer `null` together; the check covers both anyway rather than
    // relying on that.
    const score =
      similarity === null || staleness === null ? null : Math.min(similarity, staleness);
    state.lastScore = score ?? undefined;
    if (score === null) {
      // Not enough of a window to compare yet. `min_calls` gates this rule and
      // only this rule.
      state.streak = 0;
      return;
    }

    if (score <= loop.semantic.threshold) {
      state.streak = 0;
      return;
    }

    state.streak += 1;
    if (state.streak < loop.semantic.consecutive_windows) return;

    this.#trip(job, state, score, loop);
  }

  #trip(
    job: SemanticJob,
    state: SessionSemantics,
    score: number,
    loop: LoopDetectionSettings,
  ): void {
    const size = state.window.size;
    const reason: Reason = {
      code: 'LOOP_SEMANTIC',
      message:
        `The last ${size} calls are ${((state.lastSimilarity ?? score) * 100).toFixed(0)}% similar ` +
        `to each other on average, and ${((state.lastStaleness ?? score) * 100).toFixed(0)}% of what ` +
        `came back was already in one of the other answers (threshold ` +
        `${(loop.semantic.threshold * 100).toFixed(0)}% on both), for ` +
        `${loop.semantic.consecutive_windows} windows running. The arguments keep changing but the ` +
        'work does not. Stop, and report what you are stuck on instead of trying another variation.',
      evidence: {
        score: Number(score.toFixed(4)),
        similarity: Number((state.lastSimilarity ?? score).toFixed(4)),
        staleness: Number((state.lastStaleness ?? score).toFixed(4)),
        threshold: loop.semantic.threshold,
        consecutiveWindows: loop.semantic.consecutive_windows,
        windowSize: size,
        minCalls: loop.min_calls,
        model: this.#provider.id,
        fingerprints: [...state.prints],
        callIds: [...state.callIds],
      },
    };

    this.#trips += 1;
    // The only way an out-of-band detector is allowed to trip the breaker.
    // `breakerGuard` consumes it on the next call, and the first verdict left
    // for a session is the one that counts.
    this.#host.markPendingTrip(job.sessionId, reason);

    this.#telemetry.emit({
      type: 'loop_detection',
      timestamp: this.#clock.now(),
      sessionId: job.sessionId,
      code: 'LOOP_SEMANTIC',
      windowScore: Number(score.toFixed(4)),
      threshold: loop.semantic.threshold,
      enforced: this.#host.policy.policy.mode === 'enforce' && loop.on_trip !== 'warn',
      callIds: [...state.callIds],
    });

    // The history that tripped it would trip it again on the very next call,
    // which is the same reason `resetBreaker` drops the session's call window.
    state.window.clear();
    state.novelty.clear();
    state.callIds.length = 0;
    state.prints.length = 0;
    state.streak = 0;
  }

  #stateFor(sessionId: string, capacity: number): SessionSemantics {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      // A session that touches two differently-configured tools can ask for two
      // window sizes; resizing keeps the history already paid for.
      existing.window.ensureCapacity(capacity);
      existing.novelty.ensureCapacity(capacity);
      // Refresh recency: the bound below evicts the least recently scored.
      this.#sessions.delete(sessionId);
      this.#sessions.set(sessionId, existing);
      return existing;
    }

    const created: SessionSemantics = {
      window: new EmbeddingWindow({ capacity, dims: this.#provider.dims }),
      novelty: new ResultNoveltyWindow({ capacity }),
      streak: 0,
      lastScore: undefined,
      lastSimilarity: undefined,
      lastStaleness: undefined,
      callIds: [],
      prints: [],
    };
    this.#sessions.set(sessionId, created);
    while (this.#sessions.size > this.#maxSessions) {
      const oldest = this.#sessions.keys().next();
      if (oldest.done === true) break;
      this.#sessions.delete(oldest.value);
    }
    return created;
  }
}

/** Builds a detector and subscribes it to the engine in one step. */
export function attachSemanticLoopDetector(
  options: SemanticLoopDetectorOptions,
): SemanticLoopDetector {
  return new SemanticLoopDetector(options).attach();
}
