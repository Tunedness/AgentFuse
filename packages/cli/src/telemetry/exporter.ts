/**
 * The bounded, batching OTLP/HTTP exporter.
 *
 * **Telemetry must never be able to break the proxy.** A collector that is
 * down, slow, wedged behind a full socket buffer or answering with nonsense has
 * to cost the operator exactly one diagnostic line and nothing else — not a
 * delayed tool call, not a growing heap, not a retry storm aimed at a service
 * that is already struggling.
 *
 * Phase 3 solved the same problem for the embedding queue and this file is
 * deliberately the same shape (`packages/core/src/loop/queue.ts`), so there is
 * one style of bounded background work in this product rather than two:
 *
 * - **Bounded, oldest dropped.** Telemetry ages badly; when the queue is full
 *   the record most worth keeping is the newest. The drops are counted and
 *   reported at shutdown, because a silently truncated audit trail is worse
 *   than a short one that says so.
 * - **One worker.** A batch is in flight or it is not; nothing overlaps, so
 *   nothing needs a lock and the collector never sees this process fan out.
 * - **Failures are contained and never retried.** The batch is dropped and a
 *   backoff deadline is armed, doubling up to a ceiling. Retrying would
 *   multiply the load on a collector that is already failing, and the data is
 *   observational — the decisions themselves are on stderr and in the trip
 *   reports either way.
 * - **One line per outage.** The first failure of a streak is diagnosed; the
 *   rest are counted. A breaker that trips in a tight loop must not bury the
 *   wrapped server's stderr under AgentFuse's complaints about its collector.
 *
 * The one place it diverges from the embedding queue: that queue refuses to own
 * a timer because core has no clock of its own, and is woken by the next
 * `enqueue`. The CLI has no such constraint, and a telemetry record that sat
 * unexported until the next tool call would arrive after the incident it
 * describes. So a flush is scheduled on an **unref'd** timer — unref'd because
 * a wrap is held open by the agent's pipe and must never be held open by a
 * pending export.
 */

import { messageOf } from '../errors.js';
import type { OtlpResource, OtlpScope } from './otlp.js';
import { logsRequest, type OtlpLogRecord, type OtlpSpan, signalUrl, traceRequest } from './otlp.js';

/** The `fetch` shape this uses. A parameter so tests never open a socket. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Where a failed or dropped export gets reported. */
export type ExporterDiagnostic = (event: string, fields: Record<string, unknown>) => void;

/** How an {@link OtlpExporter} behaves. */
export interface OtlpExporterOptions {
  /** Base endpoint, e.g. `http://localhost:4318`. Signal paths are appended. */
  readonly endpoint: string;
  /** Injected for tests; production uses Node 20's global `fetch`. */
  readonly fetch?: FetchLike | undefined;
  /** Injected for tests. */
  readonly now?: (() => number) | undefined;
  /** Where the failure line goes. The runtime passes the single `Diagnostics`. */
  readonly onDiagnostic?: ExporterDiagnostic | undefined;
  /** Records held per signal before the oldest is dropped. Default 1024. */
  readonly capacity?: number | undefined;
  /** Largest number of records in one request. Default 128. */
  readonly batchSize?: number | undefined;
  /** How long a record may wait for company. Default 1000 ms. */
  readonly flushIntervalMs?: number | undefined;
  /** How long one POST may take. Default 5000 ms. */
  readonly timeoutMs?: number | undefined;
  /** First backoff after a failed batch. Default 1000 ms. */
  readonly retryDelayMs?: number | undefined;
  /** Ceiling for the doubling backoff. Default 30000 ms. */
  readonly maxRetryDelayMs?: number | undefined;
}

const DEFAULT_CAPACITY = 1_024;
const DEFAULT_BATCH_SIZE = 128;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;

/** What the exporter has been through. Written to the diagnostics at shutdown. */
export interface ExporterStats {
  /** Records handed to the exporter. */
  readonly accepted: number;
  /** Records dropped because a queue was full. */
  readonly dropped: number;
  /** Records the collector acknowledged. */
  readonly exported: number;
  /** Successful requests. */
  readonly requests: number;
  /** Failed requests. Each one cost its batch. */
  readonly failures: number;
  /** Whether a backoff deadline is currently in force. */
  readonly backingOff: boolean;
}

/**
 * Batches spans and log records and POSTs them as OTLP/HTTP JSON.
 *
 * Every method is safe to call after {@link shutdown}; the queues simply stop
 * accepting, which is the honest behaviour for a process on its way out.
 */
export class OtlpExporter {
  readonly #tracesUrl: string;
  readonly #logsUrl: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #diagnostic: ExporterDiagnostic | undefined;
  readonly #capacity: number;
  readonly #batchSize: number;
  readonly #flushIntervalMs: number;
  readonly #timeoutMs: number;
  readonly #retryDelayMs: number;
  readonly #maxRetryDelayMs: number;

  readonly #spans: OtlpSpan[] = [];
  readonly #logs: OtlpLogRecord[] = [];
  readonly #resource: OtlpResource;
  readonly #scope: OtlpScope;

  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #closed = false;
  /** `now()` before which no request is made. */
  #retryAfter = 0;
  #failureStreak = 0;

  #accepted = 0;
  #dropped = 0;
  #exported = 0;
  #requests = 0;
  #failures = 0;

  constructor(resource: OtlpResource, scope: OtlpScope, options: OtlpExporterOptions) {
    this.#resource = resource;
    this.#scope = scope;
    this.#tracesUrl = signalUrl(options.endpoint, 'traces');
    this.#logsUrl = signalUrl(options.endpoint, 'logs');
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#diagnostic = options.onDiagnostic;
    this.#capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.#batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.#flushIntervalMs = Math.max(1, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#retryDelayMs = Math.max(1, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.#maxRetryDelayMs = Math.max(
      this.#retryDelayMs,
      options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
    );
  }

  /** A snapshot of the counters. */
  get stats(): ExporterStats {
    return {
      accepted: this.#accepted,
      dropped: this.#dropped,
      exported: this.#exported,
      requests: this.#requests,
      failures: this.#failures,
      backingOff: this.#now() < this.#retryAfter,
    };
  }

  /** Records waiting to go, across both signals. */
  get depth(): number {
    return this.#spans.length + this.#logs.length;
  }

  /** Queues a span. Never throws, never blocks. */
  enqueueSpan(span: OtlpSpan): void {
    this.#accept(this.#spans, span);
  }

  /** Queues a log record. Never throws, never blocks. */
  enqueueLog(record: OtlpLogRecord): void {
    this.#accept(this.#logs, record);
  }

  /**
   * Sends everything queued, or gives up because a backoff is in force.
   *
   * Used by {@link shutdown} and by tests. It does not wait out a backoff: a
   * proxy that is shutting down has to actually shut down, which is the same
   * reason `Runtime.close` bounds its wait for the embedding layer.
   */
  async flush(): Promise<void> {
    for (;;) {
      const running = this.#running;
      if (running !== undefined) {
        await running;
        continue;
      }
      if (this.depth === 0) return;
      this.#pump();
      if (this.#running === undefined) return;
    }
  }

  /**
   * Stops the timer, sends what is left, and reports the counters.
   *
   * Safe to call twice. Anything still queued after a failed final flush is
   * dropped and counted — a shutdown that waited for a dead collector would
   * hang the process the operator just asked to stop.
   */
  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimer();
    await this.flush();
    const left = this.depth;
    this.#spans.length = 0;
    this.#logs.length = 0;
    this.#dropped += left;
    const stats = this.stats;
    // One line, at the end, whatever happened. A run that exported nothing
    // because nobody was listening should say so somewhere.
    this.#diagnostic?.('telemetry_stats', {
      accepted: stats.accepted,
      exported: stats.exported,
      dropped: stats.dropped,
      requests: stats.requests,
      failures: stats.failures,
    });
  }

  // -------------------------------------------------------------------------

  #accept<T>(queue: T[], record: T): void {
    if (this.#closed) {
      this.#dropped += 1;
      return;
    }
    this.#accepted += 1;
    queue.push(record);
    // Oldest first: a record that has been waiting is the one whose incident is
    // already over.
    while (queue.length > this.#capacity) {
      queue.shift();
      this.#dropped += 1;
    }
    if (queue.length >= this.#batchSize) {
      this.#pump();
      return;
    }
    this.#schedule();
  }

  /**
   * Arms the flush timer.
   *
   * The delay is the longer of the batching interval and whatever is left of a
   * backoff, so an outage costs one wake-up per backoff rather than one per
   * second for the length of it.
   */
  #schedule(): void {
    if (this.#timer !== undefined || this.#closed) return;
    const remaining = this.#retryAfter - this.#now();
    const timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.#pump();
      },
      Math.max(this.#flushIntervalMs, remaining),
    );
    // The agent's pipe holds a wrap open. A pending export never does.
    timer.unref?.();
    this.#timer = timer;
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #pump(): void {
    if (this.#running !== undefined || this.depth === 0) return;
    if (this.#now() < this.#retryAfter) {
      // Still inside a backoff. Come back when it has elapsed rather than
      // spinning on the deadline.
      this.#schedule();
      return;
    }
    this.#clearTimer();
    const run = this.#run();
    this.#running = run;
    void run.then(() => {
      this.#running = undefined;
      // Records that arrived while the batch was in flight.
      if (this.depth > 0) this.#schedule();
    });
  }

  /** The worker. Never rejects: every failure mode is handled inside. */
  async #run(): Promise<void> {
    while (this.depth > 0 && this.#now() >= this.#retryAfter) {
      const spans = this.#spans.splice(0, this.#batchSize);
      if (spans.length > 0) await this.#send(this.#tracesUrl, traceRequest, spans, 'traces');
      if (this.#now() < this.#retryAfter) break;
      const logs = this.#logs.splice(0, this.#batchSize);
      if (logs.length > 0) await this.#send(this.#logsUrl, logsRequest, logs, 'logs');
    }
  }

  async #send<T>(
    url: string,
    encode: (resource: OtlpResource, scope: OtlpScope, records: readonly T[]) => unknown,
    records: readonly T[],
    signal: string,
  ): Promise<void> {
    let body: string;
    try {
      body = JSON.stringify(encode(this.#resource, this.#scope, records));
    } catch (error) {
      // Nothing we build should be unserialisable, and if it ever is, the fix
      // is a bug report rather than a wedged queue.
      this.#fail(signal, records.length, messageOf(error));
      return;
    }

    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        // Node 20 ships this; it is the whole timeout, connection included.
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) {
        this.#fail(signal, records.length, `the collector answered HTTP ${response.status}`);
        return;
      }
    } catch (error) {
      this.#fail(signal, records.length, messageOf(error));
      return;
    }

    // The body of a successful export is deliberately not read. It carries at
    // most a `partialSuccess` note, and a collector that answers 200 with
    // garbage — or with a stream that never ends — must not be able to hold a
    // tool call's process open while we parse it.
    this.#requests += 1;
    this.#exported += records.length;
    if (this.#failureStreak > 0) {
      this.#diagnostic?.('telemetry_export_recovered', { after: this.#failureStreak });
      this.#failureStreak = 0;
    }
    this.#retryAfter = 0;
  }

  #fail(signal: string, records: number, message: string): void {
    this.#failures += 1;
    this.#dropped += records;
    const delay = Math.min(
      this.#maxRetryDelayMs,
      this.#retryDelayMs * 2 ** Math.min(this.#failureStreak, 10),
    );
    this.#failureStreak += 1;
    this.#retryAfter = this.#now() + delay;
    // Only the first failure of a streak is written. The rest are in the
    // counters, and an operator whose collector has been down for an hour does
    // not need one line per batch to learn it.
    if (this.#failureStreak === 1) {
      this.#diagnostic?.('telemetry_export_failed', { signal, records, message, retryInMs: delay });
    }
  }
}
