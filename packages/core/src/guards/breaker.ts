import type { BreakerPhase, BreakerState } from '../domain/breaker.js';
import type { Reason } from '../domain/decision.js';
import type { TripDisposition } from '../policy/schema.js';

/**
 * The circuit breaker state machine.
 *
 * Kept as one pure function over (state, event) so the transition table can be
 * tested exhaustively — every phase against every event — rather than inferred
 * from the behaviour of the guards that drive it.
 *
 * ```
 *          trip(halt)              cooldown.duration elapsed
 *  closed ────────────► open ───────────────────────────────► half_open
 *    ▲       trip(require_approval)                              │  │
 *    │ ────────────────────────────────────────────────────────► │  │
 *    │                                                           │  │
 *    └───────────── cooldown.calls consecutive approvals ────────┘  │
 *                                                                   │
 *            any re-trip, or a human denial, while half_open ───────┘
 *                              back to open
 * ```
 *
 * `half_open` is the interesting state: the human *is* the probe. Every call
 * needs an approval, and enough consecutive approvals close the circuit.
 */

/** Everything that can move the breaker. */
export type BreakerEvent =
  /** A loop or budget rule fired. */
  | { kind: 'trip'; disposition: TripDisposition; reason: Reason; now: number }
  /** `cooldown.duration` has passed since the breaker opened. */
  | { kind: 'cooldown_elapsed'; now: number }
  /** A half-open probe was approved (or, in warn mode, forwarded). */
  | { kind: 'approved'; cooldownCalls: number }
  /** A human said no. */
  | { kind: 'denied'; now: number }
  /** `agentfuse approve --reset`, or the operator calling `resetBreaker`. */
  | { kind: 'reset' };

/** What one event did. */
export interface BreakerTransition {
  from: BreakerPhase;
  to: BreakerPhase;
  /**
   * True when the loop window must be dropped. Set only when the circuit
   * closes: the history that tripped it is no longer relevant, and keeping it
   * would re-trip the breaker on the very next call.
   *
   * Budget counters are deliberately **not** cleared. A budget is a cumulative
   * fact about the session, not a transient fault to recover from.
   */
  clearWindow: boolean;
}

/**
 * Where a trip lands.
 *
 * A re-trip while probing is the strongest possible signal that the agent has
 * not recovered, so `half_open` always falls back to `open` whatever the policy
 * would otherwise have done. `on_trip: warn` never opens the circuit — it only
 * annotates the decision.
 */
function tripTarget(from: BreakerPhase, disposition: TripDisposition): BreakerPhase {
  // Already open, or probing: any further trip means open, full stop. A policy
  // that would only have asked for approval cannot downgrade an open circuit.
  if (from !== 'closed') return 'open';
  if (disposition === 'halt') return 'open';
  if (disposition === 'require_approval') return 'half_open';
  return from;
}

/** Applies one event to the breaker, in place. */
export function applyBreakerEvent(state: BreakerState, event: BreakerEvent): BreakerTransition {
  const from = state.phase;

  switch (event.kind) {
    case 'trip': {
      const to = tripTarget(from, event.disposition);
      if (to !== 'closed') {
        state.trippedAt = event.now;
        state.tripReason = event.reason;
      }
      state.phase = to;
      if (to !== from) state.approvedSinceHalfOpen = 0;
      return { from, to, clearWindow: false };
    }

    case 'cooldown_elapsed': {
      if (from !== 'open') return { from, to: from, clearWindow: false };
      state.phase = 'half_open';
      state.approvedSinceHalfOpen = 0;
      return { from, to: 'half_open', clearWindow: false };
    }

    case 'approved': {
      if (from !== 'half_open') return { from, to: from, clearWindow: false };
      state.approvedSinceHalfOpen += 1;
      if (state.approvedSinceHalfOpen < event.cooldownCalls) {
        return { from, to: 'half_open', clearWindow: false };
      }
      state.phase = 'closed';
      state.approvedSinceHalfOpen = 0;
      delete state.trippedAt;
      delete state.tripReason;
      return { from, to: 'closed', clearWindow: true };
    }

    case 'denied': {
      if (from !== 'half_open') return { from, to: from, clearWindow: false };
      state.phase = 'open';
      state.trippedAt = event.now;
      state.approvedSinceHalfOpen = 0;
      return { from, to: 'open', clearWindow: false };
    }

    case 'reset': {
      state.phase = 'closed';
      state.approvedSinceHalfOpen = 0;
      delete state.trippedAt;
      delete state.tripReason;
      return { from, to: 'closed', clearWindow: true };
    }
  }
}
