import { breakerGuard } from './breaker-guard.js';
import { budgetGuard } from './budget.js';
import { policyGuard } from './policy.js';
import { ruleLoopGuard } from './rule-loop.js';
import { type GuardContext, GuardState } from './types.js';

/** A synchronous step in the decision chain. */
export type Guard = (ctx: GuardContext, state: GuardState) => void;

/**
 * The chain, in order. The order is the design.
 *
 * 1. **Breaker** — a broken circuit answers before anything else is considered,
 *    and a verdict the semantic layer left behind has to land before this call
 *    is evaluated on stale state.
 * 2. **Policy** — permission is cheaper to check than behaviour, and a `deny`
 *    makes every later question moot.
 * 3. **Budget** — integer comparisons against counters; no history walk.
 * 4. **Rule loops** — the only guard that reads the window.
 *
 * Every one of them is synchronous. The single `await` in `beforeCall` is the
 * human approval, and it happens after the chain, once, when some guard has
 * asked for it.
 */
export const GUARDS: readonly Guard[] = [breakerGuard, policyGuard, budgetGuard, ruleLoopGuard];

/** Runs the chain until a guard produces a final answer. */
export function runGuards(ctx: GuardContext): GuardState {
  const state = new GuardState();
  for (const guard of GUARDS) {
    guard(ctx, state);
    if (state.stopped) break;
  }
  return state;
}
