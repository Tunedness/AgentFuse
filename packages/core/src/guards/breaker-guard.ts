import { applyBreakerEvent } from './breaker.js';
import { applyTrip, type GuardContext, type GuardState } from './types.js';

/**
 * Guard 1 of 4.
 *
 * Runs first because a broken circuit outranks every other consideration: if
 * the breaker is open there is nothing to evaluate, and if the semantic layer
 * left a verdict behind it has to be acted on before this call goes anywhere.
 */
export function breakerGuard(ctx: GuardContext, state: GuardState): void {
  const { session, evaluation } = ctx;
  const breaker = session.breaker;

  // The semantic scorer runs off the hot path and cannot block a decision, so
  // it leaves its verdict here for the next call to pick up. This is the only
  // place `pendingTrip` is consumed.
  const pending = session.pendingTrip;
  if (pending) {
    delete session.pendingTrip;
    applyTrip(ctx, state, pending, evaluation.loop.on_trip);
    if (state.stopped) return;
  }

  if (breaker.phase === 'open') {
    const elapsed = ctx.now - (breaker.trippedAt ?? ctx.now);
    if (elapsed >= evaluation.loop.cooldown.duration) {
      applyBreakerEvent(breaker, { kind: 'cooldown_elapsed', now: ctx.now });
    }
  }

  if (breaker.phase === 'open') {
    state.halt('deny', {
      code: 'BREAKER_OPEN',
      message:
        'The AgentFuse circuit breaker is open for this session. Stop calling tools, report what you were trying to achieve, and wait for a human to reset it.',
      evidence: {
        trippedAt: breaker.trippedAt,
        tripCode: breaker.tripReason?.code,
        tripMessage: breaker.tripReason?.message,
        cooldownMs: evaluation.loop.cooldown.duration,
        remainingMs: Math.max(
          0,
          evaluation.loop.cooldown.duration - (ctx.now - (breaker.trippedAt ?? ctx.now)),
        ),
      },
    });
    return;
  }

  if (breaker.phase === 'half_open') {
    state.raise('require_approval');
    state.add({
      code: 'BREAKER_OPEN',
      message:
        'The circuit breaker is half-open after an earlier trip. Each call needs a human approval until the session proves it has recovered.',
      evidence: {
        approvedSinceHalfOpen: breaker.approvedSinceHalfOpen,
        approvalsToClose: evaluation.loop.cooldown.calls,
        tripCode: breaker.tripReason?.code,
      },
    });
  }
}
