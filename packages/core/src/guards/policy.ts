import { toolKey } from '../policy/glob.js';
import type { GuardContext, GuardState } from './types.js';

/**
 * Guard 2 of 4.
 *
 * Turns the matched `tools` rule into a decision. `deny` is final; everything
 * else lets the behavioural guards have their say, because a call can be
 * permitted and still be the eleventh identical call in a row.
 */
export function policyGuard(ctx: GuardContext, state: GuardState): void {
  const { evaluation, record } = ctx;
  state.matchedRule = evaluation.matchedRule;
  const key = toolKey(record.serverName, record.toolName);
  const note = evaluation.note ? ` (${evaluation.note})` : '';

  switch (evaluation.action) {
    case 'deny':
      state.halt('deny', {
        code: 'POLICY_DENY',
        message: `Policy denies ${key}${note}. Do not retry; use a different approach or ask the user.`,
        evidence: { rule: evaluation.matchedRule, match: evaluation.rule?.rule.match, key },
      });
      return;

    case 'require_approval':
      state.raise('require_approval');
      state.add({
        code: 'POLICY_APPROVAL',
        message: `Policy requires human approval for ${key}${note}.`,
        evidence: { rule: evaluation.matchedRule, match: evaluation.rule?.rule.match, key },
      });
      return;

    case 'warn':
      state.raise('warn');
      state.add({
        code: 'POLICY_WARN',
        message: `Policy flags ${key}${note}. The call was forwarded.`,
        evidence: { rule: evaluation.matchedRule, match: evaluation.rule?.rule.match, key },
      });
      return;

    case 'allow':
      return;
  }
}
