import type { DecisionAction, Reason } from '../domain/decision.js';
import type { ToolCallRecord } from '../domain/records.js';
import type { SessionState } from '../domain/session.js';
import type { CompiledPolicy } from '../policy/compile.js';
import type { RuleEvaluation } from '../policy/evaluate.js';
import type { PolicyMode, TripDisposition } from '../policy/schema.js';
import type { Clock, TelemetrySink } from '../ports/index.js';
import { applyBreakerEvent } from './breaker.js';

/** Everything a guard is allowed to look at. */
export interface GuardContext {
  readonly policy: CompiledPolicy;
  readonly mode: PolicyMode;
  readonly session: SessionState;
  readonly record: ToolCallRecord;
  /**
   * The matched rule, resolved before the chain runs.
   *
   * `PolicyGuard` still owns the *decision* the rule implies; the match itself
   * is hoisted because `BreakerGuard` needs the rule's merged `on_trip` in
   * order to act on a trip the semantic layer left behind.
   */
  readonly evaluation: RuleEvaluation;
  readonly clock: Clock;
  readonly now: number;
  readonly telemetry: TelemetrySink;
}

const RANK: Record<DecisionAction, number> = {
  allow: 0,
  warn: 1,
  require_approval: 2,
  deny: 3,
};

/**
 * The verdict being assembled as the chain runs.
 *
 * `action` is always the **enforce-mode** action. Downgrading it for warn mode
 * happens once, at the very end, in the engine — so that warn mode is a single
 * well-understood transformation of a real decision rather than a second set of
 * branches scattered through every guard.
 */
export class GuardState {
  action: DecisionAction = 'allow';
  readonly reasons: Reason[] = [];
  matchedRule: string | undefined;
  /** The reason that broke the circuit on this call, if one did. */
  trip: Reason | undefined;
  /** True once a guard has produced a final answer. */
  stopped = false;

  /** Raises the running action; never lowers it. */
  raise(action: DecisionAction): void {
    if (RANK[action] > RANK[this.action]) this.action = action;
  }

  add(reason: Reason): void {
    this.reasons.push(reason);
  }

  /** Records a final answer and short-circuits the chain. */
  halt(action: DecisionAction, reason: Reason): void {
    this.raise(action);
    this.add(reason);
    this.stopped = true;
  }
}

/** Outcome of feeding a trip through the breaker. */
export interface TripOutcome {
  /**
   * False when this is the same trip the session has already reported and the
   * breaker did not move. Used to avoid rebuilding an identical trip report on
   * every call once a `warn`-disposition budget has been blown.
   */
  fresh: boolean;
  action: DecisionAction;
}

/**
 * Feeds a fired rule through the breaker and turns the resulting phase into an
 * action.
 *
 * Every trip in the system goes through here — loop rules, budgets and the
 * semantic layer's deferred verdict alike — so there is exactly one place where
 * "a rule fired" becomes "the circuit is open".
 */
export function applyTrip(
  ctx: GuardContext,
  state: GuardState,
  reason: Reason,
  disposition: TripDisposition,
): TripOutcome {
  const { session } = ctx;
  const previous = session.trips.at(-1);
  const transition = applyBreakerEvent(session.breaker, {
    kind: 'trip',
    disposition,
    reason,
    now: ctx.now,
  });

  const fresh = transition.from !== transition.to || previous?.code !== reason.code;
  if (fresh) session.trips.push(reason);

  let action: DecisionAction;
  if (transition.to === 'open') action = 'deny';
  else if (transition.to === 'half_open') action = 'require_approval';
  else action = 'warn';

  // Only a fresh trip earns a report; a blown `warn` budget must not rebuild an
  // identical report on every remaining call of the session.
  if (fresh) state.trip ??= reason;
  state.raise(action);
  state.add(reason);
  if (action === 'deny') state.stopped = true;

  return { fresh, action };
}
