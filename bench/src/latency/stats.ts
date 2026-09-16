/**
 * Percentiles, and the one arithmetic decision worth arguing about.
 *
 * PRD §6 budgets the **added** latency of interposing AgentFuse at p95 < 50 ms.
 * "Added" is computed here as the difference of percentiles — p95(proxied)
 * minus p95(direct) — not as the p95 of per-call differences, because there are
 * no pairs: the direct run and the proxied run are separate processes making
 * separate calls, and pairing call *i* of one with call *i* of the other would
 * be inventing a correspondence that does not exist.
 *
 * The difference of percentiles is the honest reading of "how much slower is
 * the 95th-percentile call once the breaker is in front of it", which is what
 * the budget is about.
 */

/** A latency distribution in milliseconds. */
export interface Distribution {
  readonly samples: number;
  readonly min: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** Nearest-rank percentile over an already sorted array. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
}

/** Summarises a sample of durations in milliseconds. */
export function summarise(samples: readonly number[]): Distribution {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    min: sorted[0] ?? Number.NaN,
    mean: sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

/** `proxied − direct`, percentile by percentile. */
export function added(direct: Distribution, proxied: Distribution): Distribution {
  return {
    samples: Math.min(direct.samples, proxied.samples),
    min: proxied.min - direct.min,
    mean: proxied.mean - direct.mean,
    p50: proxied.p50 - direct.p50,
    p95: proxied.p95 - direct.p95,
    p99: proxied.p99 - direct.p99,
    max: proxied.max - direct.max,
  };
}

/** Milliseconds, to three decimals, because the numbers here are small. */
export function ms(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '—';
}
