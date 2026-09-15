import type { TripCode } from '../domain/decision.js';
import type { BudgetDimension } from '../domain/events.js';
import { formatDuration } from '../policy/duration.js';
import { applyTrip, type GuardContext, type GuardState } from './types.js';

/** Fractions of a limit at which the operator hears about it. */
const NOTICE_THRESHOLDS = [0.5, 0.8, 1] as const;

interface Gauge {
  dimension: BudgetDimension;
  code: TripCode;
  value: number;
  limit: number;
  /** Renders a value for humans, with its unit. */
  format(value: number): string;
}

function gauges(ctx: GuardContext): Gauge[] {
  const { counters } = ctx.session;
  const budgets = ctx.policy.policy.budgets;
  return [
    {
      dimension: 'calls',
      code: 'BUDGET_CALLS',
      value: counters.calls,
      limit: budgets.max_calls,
      format: (v) => `${v} calls`,
    },
    {
      dimension: 'duration',
      code: 'BUDGET_DURATION',
      // Wall clock, not summed tool time: `max_duration: 30m` means "do not let
      // this agent run for half an hour".
      value: ctx.now - ctx.session.startedAt,
      limit: budgets.max_duration,
      format: formatDuration,
    },
    {
      dimension: 'tokens',
      code: 'BUDGET_TOKENS',
      value: counters.tokensEstimated,
      limit: budgets.max_tokens_estimated,
      format: (v) => `~${v} tokens`,
    },
    {
      dimension: 'usd',
      code: 'BUDGET_USD',
      value: counters.usdEstimated,
      limit: budgets.max_usd_estimated,
      format: (v) => `~$${v.toFixed(2)}`,
    },
  ];
}

/**
 * Guard 3 of 4.
 *
 * Meters the session against its budgets and announces each 50% / 80% / 100%
 * crossing exactly once — hence `budgetNotified`. Repeating the 80% warning on
 * every subsequent call would train the operator to ignore it.
 *
 * Token and dollar figures here are floor estimates of **tool I/O only**; they
 * are not the LLM's usage, and every surface that shows them says so.
 */
export function budgetGuard(ctx: GuardContext, state: GuardState): void {
  const { session } = ctx;
  const onExceeded = ctx.policy.policy.budgets.on_exceeded;

  for (const gauge of gauges(ctx)) {
    if (gauge.limit <= 0) continue;
    const ratio = gauge.value / gauge.limit;

    for (const threshold of NOTICE_THRESHOLDS) {
      if (ratio < threshold) continue;
      const key = `${gauge.dimension}:${threshold}`;
      if (session.budgetNotified.has(key)) continue;
      session.budgetNotified.add(key);
      ctx.telemetry.emit({
        type: 'budget_event',
        timestamp: ctx.now,
        sessionId: session.sessionId,
        dimension: gauge.dimension,
        ratio,
        value: gauge.value,
        limit: gauge.limit,
        action: threshold === 1 && onExceeded !== 'warn' ? 'deny' : 'warn',
      });
    }

    if (ratio < 1) continue;

    applyTrip(
      ctx,
      state,
      {
        code: gauge.code,
        message: `Session budget exhausted: ${gauge.format(gauge.value)} of ${gauge.format(gauge.limit)}. Summarise what you have and stop.`,
        evidence: {
          dimension: gauge.dimension,
          value: gauge.value,
          limit: gauge.limit,
          ratio,
          estimate: gauge.dimension === 'tokens' || gauge.dimension === 'usd',
        },
      },
      onExceeded,
    );
    if (state.stopped) return;
  }
}
