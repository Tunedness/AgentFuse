/**
 * Why the single combined embedding cannot separate a loop from progress, and
 * what does.
 *
 * The first full sweep produced a flat refusal: with one vector per call over
 * `semanticEmbeddingText`, the reworded-retry positives sit *below* the
 * pagination and bulk-edit negatives on the same axis. No horizontal line
 * separates them, so no threshold exists — the problem is the axis, not the
 * cut.
 *
 * The reason is visible in phase 4's own table. `search_issues` page 1 against
 * page 2 scored **0.9971**; the same tool asked "login bug" then "login error"
 * scored **0.9791**. The pair that should be furthest apart is the closer one.
 * That happens because the combined text is dominated by the tool name and the
 * arguments, which barely move in either case, while the part that actually
 * distinguishes them — the answer — is one short line at the end of a 1000
 * character string.
 *
 * This file measures the alternative: embed the request and the answer
 * *separately*, keep a window over each, and score the pair. A loop is a
 * request that keeps producing the same answer, so both windows must converge;
 * pagination converges on the request axis and diverges on the answer axis, and
 * one number cannot express that.
 *
 * Run with `node dist/detection/ablation.js`. It writes nothing; it is evidence
 * for a decision, and the decision it supports lives in `packages/core`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EmbeddingProvider, ToolCallRecord } from '@agentfuse/core';
import {
  EmbeddingWindow,
  errorSignature,
  MAX_ARGS_CHARS,
  MAX_SUMMARY_CHARS,
  normalizeArgs,
  semanticEmbeddingText,
  toolKey,
} from '@agentfuse/core';
import { fromJsonl } from './corpus.js';
import { criticalThreshold } from './sweep.js';
import type { CorpusCall, CorpusSession } from './types.js';

const CORPUS = fileURLToPath(new URL('../../detection/corpus.jsonl', import.meta.url));
const EMBEDDINGS_PACKAGE = '@agentfuse/embeddings-local';
const NOW = 1_770_000_000_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function summaryOf(call: CorpusCall): string {
  if (!call.isError) return call.result.slice(0, 512);
  const signature = errorSignature({
    text: call.result,
    ...(call.errorCode !== undefined ? { code: call.errorCode } : undefined),
  });
  return `ERROR(${signature}): ${call.result.slice(0, 512)}`;
}

/** The three candidate texts, per call. */
interface Texts {
  readonly combined: string;
  readonly request: string;
  readonly answer: string;
}

function textsFor(session: CorpusSession): Texts[] {
  return session.calls.map((call, index) => {
    const key = toolKey(call.serverName, call.toolName);
    const argsNormalized = normalizeArgs(call.args, NOW);
    const record: ToolCallRecord = {
      id: `${session.id}-${index}`,
      sessionId: session.id,
      serverName: call.serverName,
      toolName: call.toolName,
      args: call.args,
      argsNormalized,
      fingerprint: '',
      startedAt: NOW,
      outcome: {
        isError: call.isError,
        resultSummary: call.result.slice(0, 512),
        resultBytes: call.resultBytes,
        ...(call.isError
          ? {
              errorSignature: errorSignature({
                text: call.result,
                ...(call.errorCode !== undefined ? { code: call.errorCode } : undefined),
              }),
            }
          : undefined),
      },
    };
    return {
      combined: semanticEmbeddingText(record),
      request: `${key}\n${clip(argsNormalized, MAX_ARGS_CHARS)}`,
      answer: `${key}\nresult: ${clip(summaryOf(call), MAX_SUMMARY_CHARS)}`,
    };
  });
}

async function embed(provider: EmbeddingProvider, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 8)
    out.push(...(await provider.embed(texts.slice(i, i + 8))));
  return out;
}

interface EmbeddingsModule {
  createEmbeddingProvider?: (options: { model: string }) => Promise<EmbeddingProvider>;
}

const WINDOW = 6;
const MIN_CALLS = 5;
const CONSECUTIVE = 2;

/**
 * A third axis with no model in it: how much of each answer the agent had
 * already seen.
 *
 * A loop produces no new information. Pagination, a bulk edit and a traversal
 * all produce a new path, a new id or a new page of rows on every turn, and
 * that is visible in the raw tokens of the result without embedding anything.
 * The quantity is *staleness*: one minus the fraction of a result's tokens that
 * did not appear in any earlier result still inside the window.
 */
/**
 * The cosine-only window score.
 *
 * A local copy rather than `sweep.ts`'s, which now mirrors the shipped detector
 * and therefore includes the staleness gate. This file is the record of the
 * investigation that produced that gate, so it has to keep measuring the
 * *previous* axis exactly as it was.
 */
function similaritySequence(
  vectors: readonly Float32Array[],
  window: number,
  minCalls: number,
): (number | null)[] {
  const ring = new EmbeddingWindow({ capacity: window, dims: vectors[0]?.length ?? 384 });
  return vectors.map((vector) => {
    ring.push(vector);
    return ring.score(minCalls);
  });
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function stalenessSequence(
  summaries: readonly string[],
  window: number,
  minCalls: number,
  requests: readonly string[] = [],
): (number | null)[] {
  const sets = summaries.map(tokens);
  const asked = requests.map(tokens);
  return summaries.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const size = i - start + 1;
    if (size < Math.max(2, minCalls)) return null;

    // Document frequency over the window: how many of its calls each token
    // appears in. Symmetric rather than "appeared earlier", because a window is
    // a set of calls and not an ordering, and because a document-frequency map
    // is maintainable incrementally on push and evict.
    const df = new Map<string, number>();
    for (let k = start; k <= i; k += 1) {
      for (const token of sets[k] as Set<string>) df.set(token, (df.get(token) ?? 0) + 1);
    }

    let total = 0;
    for (let k = start; k <= i; k += 1) {
      const current = sets[k] as Set<string>;
      if (current.size === 0) {
        total += 1;
        continue;
      }
      const ownRequest = asked[k];
      let shared = 0;
      for (const token of current) {
        // A token counts as "already known" when another call in the window
        // also produced it, or when the agent itself put it in the request: a
        // tool that hands back the words it was given told the agent nothing.
        if ((df.get(token) ?? 0) >= 2 || ownRequest?.has(token) === true) shared += 1;
      }
      total += shared / current.size;
    }
    return total / size;
  });
}

async function main(): Promise<void> {
  const sessions = fromJsonl(readFileSync(CORPUS, 'utf8'));
  const module = (await import(EMBEDDINGS_PACKAGE)) as EmbeddingsModule;
  const factory = module.createEmbeddingProvider;
  if (typeof factory !== 'function') throw new Error('no createEmbeddingProvider');
  const provider = await factory({ model: 'Xenova/all-MiniLM-L6-v2' });

  const rows = new Map<
    string,
    {
      label: string;
      combined: number[];
      paired: number[];
      stale: number[];
      gated: number[];
      discount: number[];
      discountGated: number[];
    }
  >();

  for (const session of sessions) {
    const texts = textsFor(session);
    const combined = await embed(
      provider,
      texts.map((t) => t.combined),
    );
    const request = await embed(
      provider,
      texts.map((t) => t.request),
    );
    const answer = await embed(
      provider,
      texts.map((t) => t.answer),
    );

    const combinedScores = similaritySequence(combined, WINDOW, MIN_CALLS);
    const requestScores = similaritySequence(request, WINDOW, MIN_CALLS);
    const answerScores = similaritySequence(answer, WINDOW, MIN_CALLS);
    // The paired score: both axes have to agree that nothing is moving.
    const pairedScores = requestScores.map((r, i) => {
      const a = answerScores[i];
      return r === null || a === null || a === undefined ? null : Math.min(r, a);
    });

    const staleScores = stalenessSequence(
      session.calls.map((call) => summaryOf(call)),
      WINDOW,
      MIN_CALLS,
    );
    const discountScores = stalenessSequence(
      session.calls.map((call) => summaryOf(call)),
      WINDOW,
      MIN_CALLS,
      texts.map((t) => t.request),
    );
    const discountGated = combinedScores.map((c, i) => {
      const s = discountScores[i];
      return c === null || s === null || s === undefined ? null : Math.min(c, s);
    });
    // The gate: the combined embedding score, but only where the answers have
    // also stopped carrying anything new.
    const gatedScores = combinedScores.map((c, i) => {
      const s = staleScores[i];
      return c === null || s === null || s === undefined ? null : Math.min(c, s);
    });

    const bucket = rows.get(session.scenario) ?? {
      label: session.label,
      combined: [],
      paired: [],
      stale: [],
      gated: [],
      discount: [],
      discountGated: [],
    };
    bucket.combined.push(criticalThreshold(combinedScores, CONSECUTIVE, session.calls.length));
    bucket.paired.push(criticalThreshold(pairedScores, CONSECUTIVE, session.calls.length));
    bucket.stale.push(criticalThreshold(staleScores, CONSECUTIVE, session.calls.length));
    bucket.gated.push(criticalThreshold(gatedScores, CONSECUTIVE, session.calls.length));
    bucket.discount.push(criticalThreshold(discountScores, CONSECUTIVE, session.calls.length));
    bucket.discountGated.push(criticalThreshold(discountGated, CONSECUTIVE, session.calls.length));
    rows.set(session.scenario, bucket);
  }

  const q = (list: number[], p: number): string => {
    const sorted = list.filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) return '—';
    return (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number).toFixed(
      4,
    );
  };

  process.stdout.write(
    `\nwindow ${WINDOW}, min_calls ${MIN_CALLS}, consecutive ${CONSECUTIVE}\n\n`,
  );
  process.stdout.write(
    '| scenario | label | combined p50 | combined max | stale p50 | stale max | discount p50 | discount max | dGated p50 | dGated max |\n',
  );
  process.stdout.write('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n');
  for (const [scenario, bucket] of rows) {
    process.stdout.write(
      `| ${scenario} | ${bucket.label} | ${q(bucket.combined, 0.5)} | ${q(bucket.combined, 1)} | ${q(bucket.stale, 0.5)} | ${q(bucket.stale, 1)} | ${q(bucket.discount, 0.5)} | ${q(bucket.discount, 1)} | ${q(bucket.discountGated, 0.5)} | ${q(bucket.discountGated, 1)} |\n`,
    );
  }

  // The separation that matters: can one line sit above every negative and
  // below enough positives?
  for (const axis of [
    'combined',
    'paired',
    'stale',
    'gated',
    'discount',
    'discountGated',
  ] as const) {
    const positives: number[] = [];
    const negatives: number[] = [];
    for (const bucket of rows.values()) {
      (bucket.label === 'positive' ? positives : negatives).push(...bucket[axis]);
    }
    const maxNegative = Math.max(...negatives.filter(Number.isFinite));
    const caught = positives.filter((value) => value > maxNegative).length;
    process.stdout.write(
      `\n${axis}: highest negative ${maxNegative.toFixed(4)}; ${caught}/${positives.length} positives sit above it\n`,
    );
  }

  await provider.close?.();
}

await main();
