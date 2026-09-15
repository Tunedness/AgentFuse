import type { CompiledPolicy, CompiledRule } from './compile.js';
import type { LoopDetectionSettings, RuleAction } from './schema.js';

/** The outcome of matching one call against the `tools` list. */
export interface RuleEvaluation {
  /** `undefined` when no rule matched. */
  rule: CompiledRule | undefined;
  /** `tools[n]` when a rule matched. */
  matchedRule: string | undefined;
  /** The matched rule's action; `allow` when nothing matched. */
  action: RuleAction;
  /** Loop settings in force for this call, rule override already merged. */
  loop: LoopDetectionSettings;
  /**
   * Operator's assertion that repeating this call is harmless. Doubles the
   * exact-repeat threshold.
   */
  idempotent: boolean;
  /** The rule's `note`, for approval prompts and reports. */
  note: string | undefined;
}

/**
 * First match wins.
 *
 * An unmatched tool is **allowed**: AgentFuse is transparent until configured
 * otherwise, so dropping it in front of an existing server changes nothing
 * until someone writes rules. The loop and budget guards still run — those are
 * about the agent's behaviour, not about permission.
 */
export function evaluateRules(
  policy: CompiledPolicy,
  serverName: string,
  toolName: string,
): RuleEvaluation {
  const rule = policy.match(serverName, toolName);
  if (!rule) {
    return {
      rule: undefined,
      matchedRule: undefined,
      action: 'allow',
      loop: policy.policy.loop_detection,
      idempotent: false,
      note: undefined,
    };
  }
  return {
    rule,
    matchedRule: rule.id,
    action: rule.rule.action,
    loop: rule.loop,
    idempotent: rule.rule.idempotent,
    note: rule.rule.note,
  };
}
