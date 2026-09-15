import type { DecisionAction, TripCode } from './decision.js';

/**
 * The four telemetry event types umbrella ADR-003 mandates for the
 * `tunedness.*` schema.
 *
 * There is deliberately no `security_event` here: that one belongs to McpGuard,
 * and AgentFuse must never emit it. A breaker trip is a reliability signal, not
 * a security finding, and conflating them would poison the shared schema.
 *
 * Field names are camelCase in-core; mapping them onto `tunedness.*` attribute
 * names is the sink implementation's job.
 */
export type FuseEvent = ToolCallEvent | PolicyDecisionEvent | BudgetEvent | LoopDetectionEvent;

/** Fields every event carries. */
export interface FuseEventBase {
  /** `Clock.now()` at emission. */
  timestamp: number;
  sessionId: string;
}

/** Emitted once per completed call, from `afterCall`. */
export interface ToolCallEvent extends FuseEventBase {
  type: 'tool_call';
  callId: string;
  serverName: string;
  toolName: string;
  isError: boolean;
  errorSignature?: string;
  durationMs: number;
  tokensEstimated: { args: number; results: number };
}

/** Emitted once per decision, from `beforeCall`. */
export interface PolicyDecisionEvent extends FuseEventBase {
  type: 'policy_decision';
  callId: string;
  action: DecisionAction;
  mode: 'warn' | 'enforce';
  wouldTrip: boolean;
  matchedRule?: string;
  codes: TripCode[];
  /** Set when an `onDecision` hook threw and was contained. */
  hookError?: string;
}

/** Emitted when a budget dimension crosses 50%, 80% or 100% of its limit. */
export interface BudgetEvent extends FuseEventBase {
  type: 'budget_event';
  dimension: BudgetDimension;
  /** Consumed / limit, at the moment of the crossing. */
  ratio: number;
  value: number;
  limit: number;
  /** What the engine did about it. `warn` for the 50% and 80% notices. */
  action: DecisionAction;
}

/** The budget dimensions the engine meters. */
export type BudgetDimension = 'calls' | 'duration' | 'tokens' | 'usd';

/** Emitted when a loop rule fires, whether or not enforcement followed. */
export interface LoopDetectionEvent extends FuseEventBase {
  type: 'loop_detection';
  code: TripCode;
  /** Similarity score for `LOOP_SEMANTIC`; absent for the deterministic rules. */
  windowScore?: number;
  threshold: number;
  /** False in warn mode: the rule fired but the call was still forwarded. */
  enforced: boolean;
  callIds: string[];
}
