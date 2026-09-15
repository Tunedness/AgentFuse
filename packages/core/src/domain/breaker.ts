import type { Reason } from './decision.js';

/**
 * Circuit breaker phase.
 *
 * `closed` is the healthy state (calls flow). `open` denies everything.
 * `half_open` lets calls through one at a time behind a human approval — the
 * human is the probe.
 */
export type BreakerPhase = 'closed' | 'open' | 'half_open';

/** Per-session breaker state. */
export interface BreakerState {
  phase: BreakerPhase;
  /** `Clock.now()` of the transition out of `closed`. */
  trippedAt?: number;
  /** The reason that opened the breaker, retained for every subsequent denial. */
  tripReason?: Reason;
  /**
   * How many consecutive calls have been approved (or, in warn mode, forwarded)
   * without re-tripping since entering `half_open`. Reaching
   * `loop_detection.cooldown.calls` closes the breaker.
   */
  approvedSinceHalfOpen: number;
}

/** Creates the state a fresh session starts in. */
export function initialBreakerState(): BreakerState {
  return { phase: 'closed', approvedSinceHalfOpen: 0 };
}
