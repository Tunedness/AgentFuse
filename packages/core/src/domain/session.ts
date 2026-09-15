import type { BreakerState } from './breaker.js';
import type { Reason } from './decision.js';
import type { ToolCallRecord } from './records.js';

/**
 * Running totals for one session.
 *
 * `durationMs` is session **wall clock** (`lastActivityAt - startedAt`), not the
 * sum of individual call durations. That is what `budgets.max_duration: 30m`
 * means to the person who wrote it: "do not let this agent run for half an
 * hour", not "do not spend half an hour inside tools".
 *
 * `argsTokens` and `resultTokens` are tracked separately from their sum because
 * a trip report has to show the split — and because input and output tokens are
 * priced differently.
 */
export interface SessionCounters {
  calls: number;
  durationMs: number;
  tokensEstimated: number;
  usdEstimated: number;
  argsTokens: number;
  resultTokens: number;
}

/** Everything the engine remembers about one agent session. */
export interface SessionState {
  sessionId: string;
  startedAt: number;
  lastActivityAt: number;
  breaker: BreakerState;
  counters: SessionCounters;
  /**
   * Budget thresholds already announced, keyed `"<dimension>:<ratio>"` (e.g.
   * `"calls:0.8"`), so each crossing is reported exactly once per session
   * instead of on every call after the crossing.
   */
  budgetNotified: Set<string>;
  /**
   * Ring buffer of completed calls, newest last. Capacity is the largest window
   * any loop rule (or the trip report) could ask for.
   */
  window: ToolCallRecord[];
  /**
   * Written by the asynchronous semantic layer, consumed by `BreakerGuard` on
   * the next call.
   *
   * This is the seam that keeps embedding work off the hot path: the semantic
   * scorer never blocks a decision, it just leaves a note for the next one.
   */
  pendingTrip?: Reason;
  /** Set when the embedding queue shed load and stopped scoring every call. */
  degraded?: 'sampled';
  /** Calls that have started but not yet reported an outcome, keyed by call id. */
  inFlight: Map<string, ToolCallRecord>;
  /** Number of completed calls that reported an error. */
  errorCalls: number;
  /** Every reason that has broken the circuit in this session, oldest first. */
  trips: Reason[];
  /** Abort handles for approvals currently awaiting a human. */
  pendingApprovals: Set<AbortController>;
}

/** What `FuseEngine.endSession()` hands back to the caller. */
export interface SessionSummary {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  calls: number;
  errorCalls: number;
  tokensEstimated: {
    args: number;
    results: number;
    total: number;
    /** Required caveat, per ADR-007: never ship an estimate without it. */
    note: string;
  };
  usdEstimated: number;
  breakerPhase: BreakerState['phase'];
  trips: Reason[];
  degraded: boolean;
}
