/**
 * Replaying the corpus through the real engine.
 *
 * Two passes, and the separation is the point:
 *
 * 1. {@link replayDeterministic} pushes a session through a real
 *    {@link FuseEngine} with the semantic layer switched off, so what comes
 *    back is exactly what R1, R2 and R3 can see. That answer does not depend on
 *    any threshold, so it is computed once per `window` value and reused across
 *    the whole sweep.
 * 2. {@link embedSession} turns each call into the vector the semantic layer
 *    would have scored — through `semanticEmbeddingText`, the same contract the
 *    detector uses, never a paraphrase of it.
 *
 * The sweep then combines the two arithmetically (`sweep.ts`), and
 * {@link replayEndToEnd} re-runs the winning configuration through the real
 * engine *with* the detector attached, so the headline numbers come from the
 * product rather than from a model of it.
 */

import type { EmbeddingProvider } from '@agentfuse/core';
import {
  type BeforeCallInput,
  type CallOutcome,
  CounterIdGenerator,
  errorSignature,
  FakeClock,
  FuseEngine,
  type FusePolicy,
  normalizeArgs,
  parsePolicy,
  SemanticLoopDetector,
  semanticEmbeddingText,
  type ToolCallRecord,
  type TripCode,
} from '@agentfuse/core';
import type { CorpusCall, CorpusSession } from './types.js';

/** Milliseconds of simulated wall clock per call. */
const CALL_MS = 40;

/** What one replay found. */
export interface ReplayOutcome {
  /** Index of the call the breaker stopped, or `null` when nothing tripped. */
  readonly tripIndex: number | null;
  /** The code of the reason that stopped it. */
  readonly tripCode: TripCode | null;
  /** The window score at the moment of a semantic trip, when there was one. */
  readonly tripScore: number | null;
}

function outcomeOf(call: CorpusCall): CallOutcome {
  return {
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
  };
}

function inputOf(sessionId: string, call: CorpusCall): BeforeCallInput {
  return {
    sessionId,
    serverName: call.serverName,
    toolName: call.toolName,
    args: call.args,
  };
}

/**
 * A policy with the semantic layer off, for the deterministic pass.
 *
 * `mode: 'enforce'` because a trip has to actually stop the session: in `warn`
 * every decision comes back `allow`/`warn` and the benchmark would have to
 * infer the trip from `wouldTrip`, which is a second code path to get wrong.
 * What is being measured is whether the breaker *would* fire, and enforce is
 * the mode in which that question has a one-word answer.
 */
export function deterministicPolicy(window: number): FusePolicy {
  // Through `parsePolicy`, never hand-built: a benchmark that assembled its own
  // policy object would silently skip every default the schema fills in, and
  // then measure a configuration no user can express.
  return parsePolicy({
    version: 1,
    mode: 'enforce',
    loop_detection: { window, semantic: { enabled: false, provider: 'none' } },
    // The budgets must not fire: this benchmark measures loop detection, and a
    // session halted for spending would be counted as a detection.
    budgets: { max_calls: 100_000, max_duration: '24h', max_tokens_estimated: 100_000_000 },
  });
}

/** Pushes one session through the engine and reports where it stopped. */
export async function replayDeterministic(
  session: CorpusSession,
  policy: FusePolicy,
): Promise<ReplayOutcome> {
  const clock = new FakeClock();
  const engine = new FuseEngine(policy, { clock, ids: new CounterIdGenerator('01BENCH') });

  for (const [index, call] of session.calls.entries()) {
    const decision = await engine.beforeCall(inputOf(session.id, call));
    if (decision.action === 'deny' || decision.action === 'require_approval') {
      return {
        tripIndex: index,
        tripCode: decision.reasons[0]?.code ?? null,
        tripScore: null,
      };
    }
    engine.afterCall(decision.callId, outcomeOf(call));
    clock.advance(CALL_MS);
  }
  return { tripIndex: null, tripCode: null, tripScore: null };
}

/**
 * The exact text the semantic layer would embed for each call.
 *
 * Built from a `ToolCallRecord` rather than assembled by hand, so this shares
 * the one implementation of the contract phase 3 froze. `now` is fixed so the
 * epoch mask in `normalizeArgs` behaves identically on every machine.
 */
export function embeddingTexts(session: CorpusSession, now: number): string[] {
  return session.calls.map((call, index) => {
    const record: ToolCallRecord = {
      id: `${session.id}-${index}`,
      sessionId: session.id,
      serverName: call.serverName,
      toolName: call.toolName,
      args: call.args,
      argsNormalized: normalizeArgs(call.args, now),
      fingerprint: '',
      startedAt: now,
      outcome: outcomeOf(call),
    };
    return semanticEmbeddingText(record);
  });
}

/**
 * Embeds every call of every session.
 *
 * Batched at `batchSize`, which defaults to the queue's own 8. That is not
 * cosmetic: `model_quantized.onnx` is *dynamically* quantised, so a text's
 * vector depends slightly on its batch neighbours (phase 4 measured a worst
 * case of cosine 0.9983 between the same text alone and in a batch of six).
 * Embedding the corpus in batches of a different size would calibrate the
 * thresholds against vectors production never produces.
 */
export async function embedCorpus(
  sessions: readonly CorpusSession[],
  provider: EmbeddingProvider,
  options: { readonly now: number; readonly batchSize?: number } = { now: 1_770_000_000_000 },
): Promise<Map<string, Float32Array[]>> {
  const batchSize = options.batchSize ?? 8;
  const out = new Map<string, Float32Array[]>();

  for (const session of sessions) {
    const texts = embeddingTexts(session, options.now);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      vectors.push(...(await provider.embed(texts.slice(i, i + batchSize))));
    }
    out.set(session.id, vectors);
  }
  return out;
}

/** The knobs the sweep varies and the calibration finally fixes. */
export interface LoopSettingsCandidate {
  readonly window: number;
  readonly min_calls: number;
  readonly threshold: number;
  readonly consecutive_windows: number;
}

/** Builds the full policy for one candidate. */
export function candidatePolicy(candidate: LoopSettingsCandidate): FusePolicy {
  return parsePolicy({
    version: 1,
    mode: 'enforce',
    loop_detection: {
      window: candidate.window,
      min_calls: candidate.min_calls,
      semantic: {
        enabled: true,
        provider: 'local',
        threshold: candidate.threshold,
        consecutive_windows: candidate.consecutive_windows,
      },
    },
    budgets: { max_calls: 100_000, max_duration: '24h', max_tokens_estimated: 100_000_000 },
  });
}

/**
 * The real thing: engine, detector, provider, one call at a time.
 *
 * The queue is drained after every `afterCall`, which is what makes the run
 * reproducible. In production the worker races the next call and a verdict may
 * land one or two turns later than this; draining pins it to ADR-002's
 * *guaranteed* behaviour — the trip is applied on the next call — which is the
 * behaviour the numbers should describe.
 */
export async function replayEndToEnd(
  session: CorpusSession,
  candidate: LoopSettingsCandidate,
  provider: EmbeddingProvider,
): Promise<ReplayOutcome> {
  const clock = new FakeClock();
  const engine = new FuseEngine(candidatePolicy(candidate), {
    clock,
    ids: new CounterIdGenerator('01BENCH'),
  });
  // The provider is shared across all 200 sessions, so the detector must never
  // be `close()`d here: `EmbeddingQueue.close()` calls `provider.close()`, and
  // the second session would find a released ONNX session. `forget()` is the
  // per-session teardown, and it is the one the CLI's `onSessionEnd` uses too.
  const detector = new SemanticLoopDetector({ host: engine, provider, clock }).attach();

  try {
    for (const [index, call] of session.calls.entries()) {
      const decision = await engine.beforeCall(inputOf(session.id, call));
      if (decision.action === 'deny' || decision.action === 'require_approval') {
        const score = detector.lastScore(session.id);
        return {
          tripIndex: index,
          tripCode: decision.reasons[0]?.code ?? null,
          tripScore: score ?? null,
        };
      }
      engine.afterCall(decision.callId, outcomeOf(call));
      await detector.drain();
      clock.advance(CALL_MS);
    }
    return { tripIndex: null, tripCode: null, tripScore: null };
  } finally {
    detector.forget(session.id);
  }
}
