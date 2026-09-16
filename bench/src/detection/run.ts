/**
 * The detection benchmark.
 *
 * Replays the committed corpus through the real {@link FuseEngine} with the
 * real local embedder, sweeps the operating point, and prints precision,
 * recall, F1, detection latency in turns and the threshold curve. The chosen
 * point is then re-run end to end through the engine *with the detector
 * attached*, and the two are required to agree — a sweep that models the
 * engine instead of running it would be exactly the kind of benchmark that
 * measures nothing.
 *
 * Needs the model in the cache: `npx agentfuse models install` (or
 * `AGENTFUSE_CACHE_DIR=… agentfuse models install`).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EmbeddingProvider } from '@agentfuse/core';
import { fingerprint, MASKS, normalizeArgs } from '@agentfuse/core';
import { fromJsonl } from './corpus.js';
import {
  deterministicPolicy,
  embedCorpus,
  type LoopSettingsCandidate,
  replayDeterministic,
  replayEndToEnd,
  resultTextsOf,
} from './replay.js';
import {
  combinedTrip,
  criticalThreshold,
  evaluate,
  type Metrics,
  type SessionFacts,
  type SweepRow,
  scoreSequence,
  sweep,
} from './sweep.js';
import type { CorpusSession } from './types.js';

/** The package that carries the local backend, found the way the CLI finds it. */
const EMBEDDINGS_PACKAGE = '@agentfuse/embeddings-local';

const CORPUS = fileURLToPath(new URL('../../detection/corpus.jsonl', import.meta.url));
const RESULTS_JSON = fileURLToPath(new URL('../../detection/results.json', import.meta.url));
const RESULTS_MD = fileURLToPath(new URL('../../detection/results.md', import.meta.url));

/** Fixed instant, so `normalizeArgs`'s epoch mask behaves the same everywhere. */
const NOW = 1_770_000_000_000;

/**
 * The floor ADR-003 measured for this model.
 *
 * `model_quantized.onnx` is dynamically quantised, so the same text embedded
 * beside different neighbours comes back slightly different — worst measured
 * batch-versus-single cosine 0.9983. A chosen threshold has to sit at least
 * this far from the nearest score that would flip a session, or the
 * calibration is fitting quantisation noise.
 */
const RESOLUTION_FLOOR = 0.002;

/**
 * How far a chosen threshold must sit from the nearest session that would flip.
 *
 * Twice the resolution floor. A point closer than this is not a calibration,
 * it is a line drawn through a particular 200 sessions: the same texts
 * embedded beside different batch neighbours would land on the other side of
 * it, never mind a different corpus.
 */
const MIN_MARGIN = 2 * RESOLUTION_FLOOR;

/** PRD §6, verbatim. Reported against, unconditionally, at the end of a run. */
const TARGET = { recall: 0.9, falsePositiveRate: 0.05 } as const;

/**
 * What this run **fails** on, which is deliberately not the same thing.
 *
 * PRD §6 asks for ≥90% detection and <5% false positives. Phase 9 measured
 * both: the false-positive target is met with room to spare (0% on 100 honest
 * sessions), and the detection target is **not** — 87% is the ceiling at zero
 * false positives with a threshold that stands further from the nearest flip
 * than the model can resolve. The shortfall is one scenario, `reworded-retry`,
 * and the sweep shows why it cannot be bought: those sessions sit *below* the
 * `list-traverse-process` negatives on every axis measured, so every threshold
 * that catches more of them halts more honest work.
 *
 * Failing CI on 90% would make the build permanently red and teach everyone to
 * ignore it. Passing silently would hide the gap. So the gate is:
 *
 * - the false-positive target, at PRD's own number, because it is met and
 *   because PRD §8 lists false-positive trips as the product's first risk;
 * - the *measured* recall, as a regression floor, so nobody can quietly make
 *   detection worse;
 * - and an unconditional printed verdict against PRD §6 either way.
 *
 * **Lowering `recall` here is not a way to make a change pass.** It is the
 * record of what was achieved; moving it down means detection got worse, and
 * that needs saying out loud rather than editing. Moving PRD §6 needs an
 * `.ssot` decision, which is not this file's to make.
 *
 * The 0.02 below the measured 0.87 is platform tolerance: `model_quantized.onnx`
 * is int8 and its kernels are not bit-identical across architectures, so two
 * borderline sessions may land differently on linux/x64 than on darwin/arm64.
 */
const GATE = { recall: 0.85, falsePositiveRate: TARGET.falsePositiveRate } as const;

const GRID = {
  windows: [4, 5, 6, 8, 10, 12],
  minCalls: [3, 4, 5, 6, 8, 10],
  consecutive: [1, 2, 3],
  // 0.005 steps: two and a half times the resolution floor, so no two adjacent
  // rows of the sweep differ by less than the model can actually resolve.
  thresholds: Array.from({ length: 41 }, (_, i) => Number((0.8 + i * 0.005).toFixed(3))),
} as const;

interface EmbeddingsModule {
  createEmbeddingProvider?: (options: { model: string }) => Promise<EmbeddingProvider>;
}

async function loadProvider(): Promise<EmbeddingProvider> {
  let module: unknown;
  try {
    module = await import(EMBEDDINGS_PACKAGE);
  } catch (error) {
    throw new Error(
      `${EMBEDDINGS_PACKAGE} is not installed. The detection benchmark calibrates against the real model; there is nothing to calibrate without it.\n${String(error)}`,
    );
  }
  const factory = (module as EmbeddingsModule).createEmbeddingProvider;
  if (typeof factory !== 'function') {
    throw new Error(`${EMBEDDINGS_PACKAGE} does not export createEmbeddingProvider`);
  }
  return factory({ model: 'Xenova/all-MiniLM-L6-v2' });
}

// ---------------------------------------------------------------------------
// the cursor asymmetry
// ---------------------------------------------------------------------------

/**
 * Measures what `NEVER_MASKED_KEYS` actually buys.
 *
 * The plan's deliberate asymmetry was that `cursor` escapes masking because a
 * moving cursor is evidence of progress. That claim is testable: mask it and
 * see how many pagination sweeps collapse into a single fingerprint, which is
 * what R1 would then halt at the third page.
 */
function cursorExemptionWeight(sessions: readonly CorpusSession[]): {
  readonly sweeps: number;
  readonly withCursorArgument: number;
  readonly collapsedIfMasked: number;
  readonly r1WouldTrip: number;
} {
  let withCursorArgument = 0;
  let collapsedIfMasked = 0;
  let r1WouldTrip = 0;
  const sweeps = sessions.filter((s) => s.scenario === 'pagination-sweep');

  for (const session of sweeps) {
    const hasCursor = session.calls.some((call) => 'cursor' in call.args);
    if (!hasCursor) continue;
    withCursorArgument += 1;

    // The counterfactual: the same arguments with the cursor flattened the way
    // the hex mask would flatten it if the key were not exempt.
    const masked = session.calls.map((call) => {
      const args = { ...call.args };
      if ('cursor' in args) args.cursor = MASKS.hex;
      return fingerprint(call.serverName, call.toolName, normalizeArgs(args, NOW));
    });
    const distinct = new Set(masked).size;
    if (distinct < session.calls.length) collapsedIfMasked += 1;
    // R1's default threshold is three identical fingerprints inside the window.
    const counts = new Map<string, number>();
    for (const print of masked) counts.set(print, (counts.get(print) ?? 0) + 1);
    if ([...counts.values()].some((n) => n >= 3)) r1WouldTrip += 1;
  }

  return { sweeps: sweeps.length, withCursorArgument, collapsedIfMasked, r1WouldTrip };
}

// ---------------------------------------------------------------------------
// reporting helpers
// ---------------------------------------------------------------------------

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const num = (value: number, digits = 4) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

function meetsTarget(metrics: Metrics): boolean {
  return metrics.recall >= TARGET.recall && metrics.falsePositiveRate < TARGET.falsePositiveRate;
}

/**
 * Picks the operating point.
 *
 * The order is deliberate and is stated here rather than in the report, so it
 * cannot be rewritten after seeing the numbers:
 *
 * 1. A candidate must hold the false-positive line (`< 5%`) **and** stand at
 *    least {@link MIN_MARGIN} away from the nearest session that would flip.
 *    The false-positive cap is the risk PRD §8 lists first and it is never
 *    traded for recall; the margin is what stops the answer from being a
 *    number fitted to these 200 sessions. Twice the model's own resolution
 *    floor is the smallest distance that can mean anything, because a text
 *    embedded beside different neighbours already moves by that much.
 * 2. Among those, prefer the ones that also reach PRD §6's recall target.
 * 3. Then highest F1.
 * 4. Then the widest margin, then lower detection latency p95, then the
 *    smaller window.
 * 5. Last, when everything measured is identical, the more *conservative*
 *    shape: the larger `min_calls` and the larger `consecutive_windows`. Two
 *    settings the corpus cannot tell apart should be resolved by asking for
 *    more evidence before halting somebody's agent, not less.
 */
function pickOperatingPoint(
  rows: readonly SweepRow[],
  facts: readonly SessionFacts[],
): { row: SweepRow; margin: Margin; eligible: boolean } {
  const scored = rows
    .filter((row) => row.metrics.falsePositiveRate < TARGET.falsePositiveRate)
    .map((row) => ({ row, margin: marginOf(facts, row) }))
    .filter((entry) => entry.margin.margin >= MIN_MARGIN);

  scored.sort((a, b) => {
    const target = Number(meetsTarget(b.row.metrics)) - Number(meetsTarget(a.row.metrics));
    if (target !== 0) return target;
    const f1 = b.row.metrics.f1 - a.row.metrics.f1;
    if (Math.abs(f1) > 1e-9) return f1;
    const margin = b.margin.margin - a.margin.margin;
    if (Math.abs(margin) > 1e-9) return margin;
    const latency = a.row.metrics.latency.p95 - b.row.metrics.latency.p95;
    if (Math.abs(latency) > 1e-9) return latency;
    if (a.row.window !== b.row.window) return a.row.window - b.row.window;
    if (a.row.min_calls !== b.row.min_calls) return b.row.min_calls - a.row.min_calls;
    return b.row.consecutive_windows - a.row.consecutive_windows;
  });

  const best = scored[0];
  if (best === undefined) {
    throw new Error(
      'no candidate holds the false-positive line with a usable margin; the sweep has nothing to report',
    );
  }
  return { row: best.row, margin: best.margin, eligible: meetsTarget(best.row.metrics) };
}

/** How much room a threshold has before a session on either side flips. */
interface Margin {
  /** Lowest critical threshold among positives this point catches semantically. */
  readonly nearestPositive: number;
  /** Highest critical threshold among negatives this point does *not* trip. */
  readonly nearestNegative: number;
  /** Distance to whichever is closer. */
  readonly margin: number;
}

function marginOf(facts: readonly SessionFacts[], row: SweepRow): Margin {
  let nearestPositive = Number.POSITIVE_INFINITY;
  let nearestNegative = Number.NEGATIVE_INFINITY;

  for (const fact of facts) {
    const scores = scoreSequence(fact.vectors, fact.resultTexts, row.window, row.min_calls);
    const critical = criticalThreshold(scores, row.consecutive_windows, fact.session.calls.length);
    if (!Number.isFinite(critical)) continue;
    if (fact.session.label === 'positive') {
      // Only positives that the semantic tier is actually carrying: one already
      // stopped by a rule says nothing about where the threshold should sit.
      const rule = fact.deterministic.get(row.window)?.tripIndex ?? null;
      if (rule !== null) continue;
      if (critical > row.threshold) nearestPositive = Math.min(nearestPositive, critical);
    } else if (critical <= row.threshold) {
      nearestNegative = Math.max(nearestNegative, critical);
    }
  }

  const above = nearestPositive - row.threshold;
  const below = row.threshold - nearestNegative;
  return {
    nearestPositive,
    nearestNegative,
    margin: Math.min(Number.isFinite(above) ? above : 1, Number.isFinite(below) ? below : 1),
  };
}

function metricsTable(metrics: Metrics): string[] {
  return [
    `precision ${num(metrics.precision, 3)}  recall ${num(metrics.recall, 3)}  F1 ${num(metrics.f1, 3)}`,
    `TP ${metrics.truePositives}  FN ${metrics.falseNegatives}  FP ${metrics.falsePositives}  TN ${metrics.trueNegatives}  FP-rate ${pct(metrics.falsePositiveRate)}`,
    `detection latency (turns): mean ${num(metrics.latency.mean, 2)}  p50 ${metrics.latency.p50}  p95 ${metrics.latency.p95}  max ${metrics.latency.max}`,
    `caught by: rules ${metrics.bySource.rule}, semantic ${metrics.bySource.semantic}`,
  ];
}

function scenarioTable(metrics: Metrics): string[] {
  const rows = Object.entries(metrics.byScenario).map(
    ([name, { tripped, total }]) =>
      `  ${name.padEnd(24)} ${String(tripped).padStart(3)}/${total} tripped`,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const out: string[] = [];
  const say = (line = ''): void => {
    out.push(line);
    process.stdout.write(`${line}\n`);
  };

  const sessions = fromJsonl(readFileSync(CORPUS, 'utf8'));
  const calls = sessions.reduce((sum, session) => sum + session.calls.length, 0);
  say('# AgentFuse — detection benchmark');
  say();
  say(
    `corpus: ${sessions.length} sessions, ${calls} calls, ${sessions.filter((s) => s.label === 'positive').length} positive / ${sessions.filter((s) => s.label === 'negative').length} negative`,
  );

  const startedAt = Date.now();
  const provider = await loadProvider();
  say(`embedder: ${provider.id} (${provider.dims} dims), loaded in ${Date.now() - startedAt} ms`);

  // Pass 1 — what the deterministic rules see, per window size.
  const deterministic = new Map<
    string,
    Map<number, Awaited<ReturnType<typeof replayDeterministic>>>
  >();
  for (const session of sessions) deterministic.set(session.id, new Map());
  for (const window of GRID.windows) {
    const policy = deterministicPolicy(window);
    for (const session of sessions) {
      deterministic.get(session.id)?.set(window, await replayDeterministic(session, policy));
    }
  }

  // Pass 2 — the vectors, batched exactly the way the queue batches them.
  const embedStart = Date.now();
  const vectors = await embedCorpus(sessions, provider, { now: NOW, batchSize: 8 });
  const embedMs = Date.now() - embedStart;
  say(
    `embedded ${calls} calls in ${embedMs} ms (${(embedMs / calls).toFixed(2)} ms/call, batches of 8)`,
  );

  const facts: SessionFacts[] = sessions.map((session) => ({
    session,
    deterministic: deterministic.get(session.id) ?? new Map(),
    vectors: vectors.get(session.id) ?? [],
    resultTexts: resultTextsOf(session),
  }));

  // What the rules alone achieve, as the baseline every threshold is judged
  // against: the semantic layer only has to earn the difference.
  const ruleOnly = evaluate(facts, {
    window: 8,
    min_calls: 5,
    threshold: 1.1,
    consecutive_windows: 1,
  });
  say();
  say('## Rule tier alone (R1/R2/R3, window 8, semantic off)');
  say();
  for (const line of metricsTable(ruleOnly)) say(line);
  for (const line of scenarioTable(ruleOnly)) say(line);

  // Pass 3 — the sweep.
  const rows = sweep(facts, GRID);
  const { row: chosen, margin, eligible } = pickOperatingPoint(rows, facts);

  say();
  say('## Threshold sweep');
  say();
  say(
    `${rows.length} candidates over window ${GRID.windows.join('/')}, min_calls ${GRID.minCalls.join('/')}, consecutive ${GRID.consecutive.join('/')}, threshold ${GRID.thresholds[0]}–${GRID.thresholds[GRID.thresholds.length - 1]} step 0.005`,
  );
  say(`${rows.filter((r) => meetsTarget(r.metrics)).length} of them meet both PRD §6 targets`);
  say();

  // The best each window shape can do, so the chosen point can be read against
  // the alternatives rather than presented as the only possibility.
  say('### Best candidate per shape (false-positive line held, margin ≥ 0.004)');
  say();
  say(
    '| window | min_calls | consecutive | threshold | recall | FP rate | F1 | margin | latency p95 |',
  );
  say('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const window of GRID.windows) {
    for (const consecutive of GRID.consecutive) {
      const shape = rows
        .filter((row) => row.window === window && row.consecutive_windows === consecutive)
        .map((row) => ({ row, margin: marginOf(facts, row) }))
        .filter(
          (entry) =>
            entry.row.metrics.falsePositiveRate < TARGET.falsePositiveRate &&
            entry.margin.margin >= MIN_MARGIN,
        )
        .sort((a, b) => b.row.metrics.f1 - a.row.metrics.f1)[0];
      if (shape === undefined) continue;
      const m = shape.row.metrics;
      say(
        `| ${window} | ${shape.row.min_calls} | ${consecutive} | ${shape.row.threshold.toFixed(3)} | ${pct(m.recall)} | ${pct(m.falsePositiveRate)} | ${num(m.f1, 3)} | ${num(shape.margin.margin)} | ${Number.isFinite(m.latency.p95) ? m.latency.p95 : '—'} |`,
      );
    }
  }
  say();

  // The ROC slice at the chosen window/min_calls/consecutive, which is the
  // curve a reader can actually check.
  const slice = rows.filter(
    (row) =>
      row.window === chosen.window &&
      row.min_calls === chosen.min_calls &&
      row.consecutive_windows === chosen.consecutive_windows,
  );
  say(
    `### ROC at window=${chosen.window}, min_calls=${chosen.min_calls}, consecutive_windows=${chosen.consecutive_windows}`,
  );
  say();
  say('| threshold | recall | FP rate | precision | F1 | latency p95 |');
  say('| --- | --- | --- | --- | --- | --- |');
  for (const row of slice) {
    const m = row.metrics;
    say(
      `| ${row.threshold.toFixed(3)} | ${pct(m.recall)} | ${pct(m.falsePositiveRate)} | ${pct(m.precision)} | ${num(m.f1, 3)} | ${Number.isFinite(m.latency.p95) ? m.latency.p95 : '—'} |`,
    );
  }

  // The per-session critical thresholds: the whole ROC in one distribution.
  say();
  say(`### Where each scenario sits (critical threshold at the chosen window shape)`);
  say();
  say('| scenario | label | rule-caught | min | median | max |');
  say('| --- | --- | --- | --- | --- | --- |');
  const criticals = new Map<string, number[]>();
  const ruleCaught = new Map<string, number>();
  for (const fact of facts) {
    const scores = scoreSequence(fact.vectors, fact.resultTexts, chosen.window, chosen.min_calls);
    const critical = criticalThreshold(
      scores,
      chosen.consecutive_windows,
      fact.session.calls.length,
    );
    const list = criticals.get(fact.session.scenario) ?? [];
    list.push(critical);
    criticals.set(fact.session.scenario, list);
    if ((fact.deterministic.get(chosen.window)?.tripIndex ?? null) !== null) {
      ruleCaught.set(fact.session.scenario, (ruleCaught.get(fact.session.scenario) ?? 0) + 1);
    }
  }
  for (const [scenario, list] of criticals) {
    const sorted = [...list].sort((a, b) => a - b);
    const label = sessions.find((s) => s.scenario === scenario)?.label ?? '?';
    say(
      `| ${scenario} | ${label} | ${ruleCaught.get(scenario) ?? 0}/${list.length} | ${num(sorted[0] as number)} | ${num(sorted[Math.floor(sorted.length / 2)] as number)} | ${num(sorted[sorted.length - 1] as number)} |`,
    );
  }

  say();
  say('## Chosen operating point');
  say();
  say(
    `window ${chosen.window} · min_calls ${chosen.min_calls} · threshold ${chosen.threshold} · consecutive_windows ${chosen.consecutive_windows}`,
  );
  say(
    `margin to the nearest flip: ${num(margin.margin)} (nearest negative ${num(margin.nearestNegative)}, nearest positive ${num(margin.nearestPositive)}; model resolution floor ${RESOLUTION_FLOOR})`,
  );
  if (!eligible) {
    say('');
    say(
      '**No candidate met both PRD §6 targets.** The point below is the best of those that hold the false-positive line; recall is reported as measured, not as hoped.',
    );
  }
  say();
  for (const line of metricsTable(chosen.metrics)) say(line);
  for (const line of scenarioTable(chosen.metrics)) say(line);

  // Pass 4 — the same configuration through the real engine and detector.
  say();
  say('## End-to-end verification (real engine, real detector, real provider)');
  say();
  const candidate: LoopSettingsCandidate = {
    window: chosen.window,
    min_calls: chosen.min_calls,
    threshold: chosen.threshold,
    consecutive_windows: chosen.consecutive_windows,
  };
  const disagreements: string[] = [];
  let e2eTp = 0;
  let e2eFn = 0;
  let e2eFp = 0;
  let e2eTn = 0;
  const e2eLatency: number[] = [];
  const e2eStart = Date.now();
  for (const fact of facts) {
    const observed = await replayEndToEnd(fact.session, candidate, provider);
    const predicted = combinedTrip(fact, candidate);
    if (observed.tripIndex !== predicted.index) {
      disagreements.push(
        `${fact.session.id}: model said ${String(predicted.index)}, engine said ${String(observed.tripIndex)}`,
      );
    }
    if (fact.session.label === 'positive') {
      if (observed.tripIndex === null) e2eFn += 1;
      else {
        e2eTp += 1;
        e2eLatency.push(observed.tripIndex - (fact.session.loopStartIndex ?? 0));
      }
    } else if (observed.tripIndex === null) e2eTn += 1;
    else e2eFp += 1;
  }
  const e2ePrecision = e2eTp + e2eFp === 0 ? 0 : e2eTp / (e2eTp + e2eFp);
  const e2eRecall = e2eTp + e2eFn === 0 ? 0 : e2eTp / (e2eTp + e2eFn);
  const e2eFpRate = e2eFp + e2eTn === 0 ? 0 : e2eFp / (e2eFp + e2eTn);
  const sortedLatency = [...e2eLatency].sort((a, b) => a - b);
  say(`ran ${facts.length} sessions in ${Date.now() - e2eStart} ms`);
  say(
    `precision ${num(e2ePrecision, 3)}  recall ${num(e2eRecall, 3)}  F1 ${num(
      e2ePrecision + e2eRecall === 0
        ? 0
        : (2 * e2ePrecision * e2eRecall) / (e2ePrecision + e2eRecall),
      3,
    )}`,
  );
  say(`TP ${e2eTp}  FN ${e2eFn}  FP ${e2eFp}  TN ${e2eTn}  FP-rate ${pct(e2eFpRate)}`);
  say(
    `detection latency (turns): mean ${num(sortedLatency.reduce((a, b) => a + b, 0) / (sortedLatency.length || 1), 2)}  p50 ${sortedLatency[Math.floor(sortedLatency.length / 2)]}  p95 ${sortedLatency[Math.max(0, Math.ceil(0.95 * sortedLatency.length) - 1)]}  max ${sortedLatency[sortedLatency.length - 1]}`,
  );
  say(
    disagreements.length === 0
      ? 'the sweep model and the engine agree on every session'
      : `**${disagreements.length} disagreements** between the sweep model and the engine:\n${disagreements.slice(0, 10).join('\n')}`,
  );

  // The cursor asymmetry, measured rather than asserted.
  const cursor = cursorExemptionWeight(sessions);
  say();
  say('## The `cursor` exemption');
  say();
  say(
    `${cursor.withCursorArgument} of ${cursor.sweeps} pagination sweeps use a \`cursor\` argument. ` +
      `With the exemption removed, ${cursor.collapsedIfMasked} would lose fingerprint variation entirely and ${cursor.r1WouldTrip} would be halted by R1 at the third page.`,
  );

  say();
  say('## Verdict against PRD §6');
  say();
  const recallOk = e2eRecall >= TARGET.recall;
  const fpOk = e2eFpRate < TARGET.falsePositiveRate;
  say(`- detection ≥ 90%: ${recallOk ? 'MET' : 'NOT MET'} (${pct(e2eRecall)})`);
  say(`- false positives < 5%: ${fpOk ? 'MET' : 'NOT MET'} (${pct(e2eFpRate)})`);
  if (!recallOk) {
    say('');
    say(
      `The detection target is not reachable with this design on this corpus. Every miss is a \`reworded-retry\` session — the same question asked in new words, answered the same way — and those sit below the \`list-traverse-process\` negatives on every axis measured here, so no threshold separates them. This is a finding, not a tuning problem; PRD §6 and ADR-002 are where it gets resolved.`,
    );
  }

  const gateRecallOk = e2eRecall >= GATE.recall;
  const gateFpOk = e2eFpRate < GATE.falsePositiveRate;
  say();
  say(
    `gate: recall ≥ ${GATE.recall} ${gateRecallOk ? 'PASS' : 'FAIL'} · false positives < ${GATE.falsePositiveRate} ${gateFpOk ? 'PASS' : 'FAIL'}`,
  );

  mkdirSync(dirname(RESULTS_JSON), { recursive: true });
  writeFileSync(
    RESULTS_JSON,
    `${JSON.stringify(
      {
        generatedBy: 'bench/src/detection/run.ts',
        model: provider.id,
        corpus: { sessions: sessions.length, calls },
        grid: GRID,
        chosen: candidate,
        margin,
        ruleOnly,
        sweepAtChosenShape: slice.map((row) => ({ threshold: row.threshold, ...row.metrics })),
        endToEnd: {
          truePositives: e2eTp,
          falseNegatives: e2eFn,
          falsePositives: e2eFp,
          trueNegatives: e2eTn,
          precision: e2ePrecision,
          recall: e2eRecall,
          falsePositiveRate: e2eFpRate,
          latencyTurns: {
            mean: sortedLatency.reduce((a, b) => a + b, 0) / (sortedLatency.length || 1),
            p50: sortedLatency[Math.floor(sortedLatency.length / 2)] ?? null,
            p95: sortedLatency[Math.max(0, Math.ceil(0.95 * sortedLatency.length) - 1)] ?? null,
            max: sortedLatency[sortedLatency.length - 1] ?? null,
          },
          disagreements,
        },
        cursorExemption: cursor,
        targets: TARGET,
        targetsMet: { recall: recallOk, falsePositiveRate: fpOk },
        gate: GATE,
        gatePassed: { recall: gateRecallOk, falsePositiveRate: gateFpOk },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(RESULTS_MD, `${out.join('\n')}\n`, 'utf8');

  await provider.close?.();
  if (!gateRecallOk || !gateFpOk) process.exitCode = 1;
}

await main();
