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

/**
 * How many characters of a human's approval reason are kept.
 *
 * Bounded because the text is free-form, written by a person under time
 * pressure or by a remote webhook endpoint, and it ends up inside a rendered
 * table and a JSON file somebody greps. Long enough for a sentence explaining a
 * decision, short enough that no single record can dominate a report.
 */
export const APPROVAL_REASON_LIMIT = 500;

/**
 * What a human answered, when the policy asked one.
 *
 * ADR-009: the report is an audit artifact, and "why was this call allowed" is
 * exactly what an audit asks. The verdict alone cannot answer it, so the
 * gateway's answer is carried on the decision and from there into the trip
 * report.
 */
export interface ApprovalRecord {
  /** The verdict as the gateway reported it. */
  verdict: 'approved' | 'denied' | 'timeout';
  /**
   * The words that came with it, sanitised and capped at
   * {@link APPROVAL_REASON_LIMIT}.
   *
   * Absent when nobody wrote any — a plain timeout, or a gateway that answers
   * with a bare verdict. Never a fabricated explanation.
   */
  reason?: string;
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
  /**
   * The human's answer, when one was asked for.
   *
   * Only ever set in `enforce` mode, because that is the only mode in which the
   * engine resolves an approval at all. Its presence is what tells a host that
   * this decision is part of an audit trail, whichever way it went.
   */
  approval?: ApprovalRecord;
  /** Id of the call this decision is about. */
  callId: string;
}
