/**
 * Policy surface, exposed as the `@agentfuse/core/policy` subpath export.
 *
 * TODO(phase-2): this is a stub so the subpath resolves and compiles. Phase 2
 * lands the real thing here — the zod-backed policy document, glob matching of
 * tool names to rules, the budget accounting, and the decision function the
 * proxy calls on every `tools/call`.
 */

/** What the breaker decided to do with a single tool call. */
export type PolicyDecision = 'allow' | 'deny' | 'approve';

/**
 * Decision applied when no rule matches a tool.
 *
 * Deliberately permissive: AgentFuse is transparent until it is configured
 * otherwise, so dropping it in front of an existing server changes nothing
 * until the operator writes a policy.
 */
export const DEFAULT_POLICY_DECISION: PolicyDecision = 'allow';

/** Narrows an untrusted value to a {@link PolicyDecision}. */
export function isPolicyDecision(value: unknown): value is PolicyDecision {
  return value === 'allow' || value === 'deny' || value === 'approve';
}
