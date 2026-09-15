import type { TripReport } from '../report/trip-report.js';

/** What the engine decided to do with a call. */
export type DecisionAction = 'allow' | 'warn' | 'deny' | 'require_approval';

/**
 * Machine-readable identity of a reason.
 *
 * `POLICY_WARN` is not in the original ADR-004 list. It exists because a policy
 * rule may carry `action: warn`, which is neither a denial nor an approval
 * request, and reusing `POLICY_DENY` for it would make telemetry lie about what
 * happened.
 */
export type TripCode =
  | 'LOOP_EXACT_REPEAT'
  | 'LOOP_ERROR_REPEAT'
  | 'LOOP_CYCLE'
  | 'LOOP_SEMANTIC'
  | 'BUDGET_TOKENS'
  | 'BUDGET_USD'
  | 'BUDGET_DURATION'
  | 'BUDGET_CALLS'
  | 'POLICY_DENY'
  | 'POLICY_APPROVAL'
  | 'POLICY_WARN'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_TIMEOUT'
  | 'BREAKER_OPEN';

/** Codes that represent a loop detection firing. */
export const LOOP_CODES = [
  'LOOP_EXACT_REPEAT',
  'LOOP_ERROR_REPEAT',
  'LOOP_CYCLE',
  'LOOP_SEMANTIC',
] as const satisfies readonly TripCode[];

/** Codes that represent a budget dimension being crossed. */
export const BUDGET_CODES = [
  'BUDGET_TOKENS',
  'BUDGET_USD',
  'BUDGET_DURATION',
  'BUDGET_CALLS',
] as const satisfies readonly TripCode[];

/** One explanation for a decision, addressed to the agent as much as to a human. */
export interface Reason {
  /** Stable code; safe to switch on. */
  code: TripCode;
  /**
   * English prose. Deliberately not localised: this text is fed back to the
   * agent as a tool error, and models reason better in the language they were
   * mostly trained on.
   */
  message: string;
  /** Structured backing for the message, e.g. `{ count, threshold, callIds }`. */
  evidence?: Record<string, unknown>;
}

/** The engine's verdict on a single call. */
export interface Decision {
  /** What the caller should do. */
  action: DecisionAction;
  /** Why, in order of discovery. */
  reasons: Reason[];
  /** Identity of the policy rule that matched, e.g. `tools[2]`. */
  matchedRule?: string;
  /**
   * True when the policy is in `warn` mode and `enforce` would have broken the
   * circuit. This is the number a user watches while measuring their
   * false-positive rate before turning enforcement on.
   */
  wouldTrip: boolean;
  /** Present only on the call that actually tripped the breaker. */
  report?: TripReport;
  /** Id of the call this decision is about. */
  callId: string;
}
