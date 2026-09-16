/**
 * Scoring the corpus, and sweeping the operating point.
 *
 * The sweep is arithmetic on vectors that were embedded once. Re-embedding the
 * corpus for every candidate would take the run from seconds to an hour and
 * would measure nothing extra, because `window`, `min_calls`, `threshold` and
 * `consecutive_windows` are all applied *after* the vector exists.
 *
 * The one thing this file must get exactly right is the turn ordering, because
 * everything ADR-002 promises lives in it:
 *
 * ```
 * call i  →  beforeCall (sees the verdict left by call i-1)
 *         →  forwarded
 *         →  afterCall  →  embed  →  window score  →  maybe leave a verdict
 * call i+1 →  beforeCall consumes it
 * ```
 *
 * So a window that converges after call `i` stops call `i + 1`, never call `i`.
 * `replayEndToEnd` checks this model against the real engine at the end of the
 * run, and the two are required to agree.
 */

import { EmbeddingWindow, ResultNoveltyWindow } from '@agentfuse/core';
import type { LoopSettingsCandidate, ReplayOutcome } from './replay.js';
import type { CorpusSession, ScenarioName } from './types.js';

/**
 * The window scores a session produces under one `(window, min_calls)` pair.
 *
 * `scores[i]` is the score *after* call `i` was folded in, or `null` while the
 * window is still shorter than `min_calls`. The two rings and the `min` are the
 * detector's own arithmetic, held here rather than imported because the
 * detector applies it inside a queue callback; `replayEndToEnd` checks the two
 * against each other on every session at the end of a run.
 */
export function scoreSequence(
  vectors: readonly Float32Array[],
  resultTexts: readonly string[],
  window: number,
  minCalls: number,
): (number | null)[] {
  const ring = new EmbeddingWindow({ capacity: window, dims: vectors[0]?.length ?? 384 });
  const answers = new ResultNoveltyWindow({ capacity: window });
  return vectors.map((vector, index) => {
    ring.push(vector);
    answers.push(resultTexts[index] ?? '');
    const similarity = ring.score(minCalls);
    const staleness = answers.staleness(minCalls);
    return similarity === null || staleness === null ? null : Math.min(similarity, staleness);
  });
}

/** Where the semantic rule would leave a verdict, given a score sequence. */
export function semanticTripIndex(
  scores: readonly (number | null)[],
  threshold: number,
  consecutiveWindows: number,
): number | null {
  let streak = 0;
  for (const [index, score] of scores.entries()) {
    if (score === null || score <= threshold) {
      streak = 0;
      continue;
    }
    streak += 1;
    // The verdict is consumed by the *next* call. A window that converges on
    // the last call of a session never stops anything, which is correct: the
    // agent stopped on its own.
    if (streak >= consecutiveWindows) return index + 1;
  }
  return null;
}

/**
 * The highest threshold at which this session would still trip semantically.
 *
 * The semantic rule is monotone in `threshold`: raising it can only make a trip
 * less likely. So one number per session summarises the entire ROC curve —
 * a session trips iff `threshold < criticalThreshold(...)`, and the sweep over
 * thresholds is just a sweep over where a horizontal line falls among these.
 *
 * Returns `-Infinity` for a session that never trips at any threshold (its
 * window never fills, or every convergence lands past the last call).
 */
export function criticalThreshold(
  scores: readonly (number | null)[],
  consecutiveWindows: number,
  sessionLength: number,
): number {
  let best = Number.NEGATIVE_INFINITY;
  for (let i = consecutiveWindows - 1; i < scores.length; i += 1) {
    // The verdict lands on call `i + 1`; past the end it stops nothing.
    if (i + 1 >= sessionLength) break;
    let floor = Number.POSITIVE_INFINITY;
    let complete = true;
    for (let k = 0; k < consecutiveWindows; k += 1) {
      const score = scores[i - k];
      if (score === null || score === undefined) {
        complete = false;
        break;
      }
      floor = Math.min(floor, score);
    }
    if (complete && floor > best) best = floor;
  }
  return best;
}

/** Everything the sweep needs about one session, pre-computed once. */
export interface SessionFacts {
  readonly session: CorpusSession;
  /** Where R1/R2/R3 stop it under this `window`, per window size. */
  readonly deterministic: ReadonlyMap<number, ReplayOutcome>;
  readonly vectors: readonly Float32Array[];
  /** The answer half of each call, for the novelty window. */
  readonly resultTexts: readonly string[];
}

/** The combined verdict of both tiers for one candidate. */
export function combinedTrip(
  facts: SessionFacts,
  candidate: LoopSettingsCandidate,
): { index: number | null; source: 'rule' | 'semantic' | null } {
  const rule = facts.deterministic.get(candidate.window)?.tripIndex ?? null;
  const scores = scoreSequence(
    facts.vectors,
    facts.resultTexts,
    candidate.window,
    candidate.min_calls,
  );
  const semantic = semanticTripIndex(scores, candidate.threshold, candidate.consecutive_windows);

  const length = facts.session.calls.length;
  // A verdict left by the final call has no call to land on.
  const usableSemantic = semantic !== null && semantic < length ? semantic : null;

  if (rule === null && usableSemantic === null) return { index: null, source: null };
  if (rule === null) return { index: usableSemantic, source: 'semantic' };
  if (usableSemantic === null) return { index: rule, source: 'rule' };
  return rule <= usableSemantic
    ? { index: rule, source: 'rule' }
    : { index: usableSemantic, source: 'semantic' };
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

/** Detection quality for one candidate over the whole corpus. */
export interface Metrics {
  readonly truePositives: number;
  readonly falseNegatives: number;
  readonly falsePositives: number;
  readonly trueNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  /** `FP / (FP + TN)`. This is the number PRD §6 caps at 5%. */
  readonly falsePositiveRate: number;
  /** Wasted turns before the trip, over the true positives. */
  readonly latency: { mean: number; p50: number; p95: number; max: number };
  /** Trips per scenario, for reading where a candidate goes wrong. */
  readonly byScenario: Record<string, { tripped: number; total: number }>;
  /** How many true positives each tier caught. */
  readonly bySource: { rule: number; semantic: number };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

/** Scores one candidate over the corpus. */
export function evaluate(
  facts: readonly SessionFacts[],
  candidate: LoopSettingsCandidate,
): Metrics {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;
  const latencies: number[] = [];
  const byScenario: Record<string, { tripped: number; total: number }> = {};
  const bySource = { rule: 0, semantic: 0 };

  for (const fact of facts) {
    const scenario = fact.session.scenario as ScenarioName;
    const bucket = byScenario[scenario] ?? { tripped: 0, total: 0 };
    byScenario[scenario] = bucket;
    bucket.total += 1;

    const { index, source } = combinedTrip(fact, candidate);
    if (index !== null) bucket.tripped += 1;

    if (fact.session.label === 'positive') {
      if (index === null) {
        fn += 1;
      } else {
        tp += 1;
        latencies.push(index - (fact.session.loopStartIndex ?? 0));
        if (source !== null) bySource[source] += 1;
      }
    } else if (index === null) {
      tn += 1;
    } else {
      fp += 1;
    }
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const sorted = [...latencies].sort((a, b) => a - b);

  return {
    truePositives: tp,
    falseNegatives: fn,
    falsePositives: fp,
    trueNegatives: tn,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    falsePositiveRate: fp + tn === 0 ? 0 : fp / (fp + tn),
    latency: {
      mean: sorted.length === 0 ? Number.NaN : sorted.reduce((a, b) => a + b, 0) / sorted.length,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      max: sorted.length === 0 ? Number.NaN : (sorted[sorted.length - 1] as number),
    },
    byScenario,
    bySource,
  };
}

/** One row of the sweep. */
export interface SweepRow extends LoopSettingsCandidate {
  readonly metrics: Metrics;
}

/** Evaluates the cartesian product of the given grids. */
export function sweep(
  facts: readonly SessionFacts[],
  grid: {
    readonly windows: readonly number[];
    readonly minCalls: readonly number[];
    readonly thresholds: readonly number[];
    readonly consecutive: readonly number[];
  },
): SweepRow[] {
  const rows: SweepRow[] = [];
  for (const window of grid.windows) {
    for (const min_calls of grid.minCalls) {
      // `min_calls` above `window` can never be reached: the ring holds at most
      // `window` vectors, so the rule would be permanently off.
      if (min_calls > window) continue;
      for (const consecutive_windows of grid.consecutive) {
        for (const threshold of grid.thresholds) {
          const candidate = { window, min_calls, threshold, consecutive_windows };
          rows.push({ ...candidate, metrics: evaluate(facts, candidate) });
        }
      }
    }
  }
  return rows;
}
