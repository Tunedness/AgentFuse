/**
 * The ONNX Runtime adapter. **The only file in this package that touches
 * `onnxruntime-node`** — `boundary.test.ts` fails the build if that stops being
 * true, for the same reason the proxy pins its own import boundary: the
 * interesting logic must stay runnable without 301 MB of native binaries.
 *
 * ## Why the import is dynamic
 *
 * `@agentfuse/embeddings-local`'s entry point is imported by the CLI just to
 * find out whether the package is installed at all, and `agentfuse models
 * install` imports it to download a model it has not got yet. Neither needs an
 * inference session. Loading `onnxruntime-node` at module scope would make both
 * of those pay for dlopen-ing a hundred-megabyte native addon, so the runtime
 * is pulled in here, inside the function that is about to run a model.
 *
 * ## Why `run` is awaited and never made synchronous
 *
 * `onnxruntime-node` executes `session.run` on a libuv worker thread and
 * resolves a promise when it is done. That is the property the whole design
 * rests on: phase 3 put embedding on an asynchronous queue specifically so the
 * proxy's `tools/call` forwarding never waits for a model, and that only holds
 * if the inference itself is off the event loop. The binding also exposes a
 * synchronous path; using it would move a 5–20 ms matrix multiply onto the
 * thread that is supposed to be forwarding JSON-RPC frames, and the p95 latency
 * budget in PRD §6 would start including it.
 */

import { availableParallelism } from 'node:os';
import type { EncodedBatch } from './batch.js';

/** One loaded model, reduced to what the provider actually asks of it. */
export interface EmbeddingSession {
  /**
   * Runs one padded batch and returns `last_hidden_state`, flattened
   * `[rows, length, dims]`.
   */
  run(batch: EncodedBatch): Promise<Float32Array>;
  /** Frees the native session. Idempotent. */
  close(): Promise<void>;
}

/** How {@link openSession} configures the runtime. */
export interface SessionOptions {
  /**
   * Intra-op threads. Defaults to at most four.
   *
   * Embedding is background work behind a queue: it is allowed to be slower
   * than it could be, and it is not allowed to take a 64-core machine away from
   * whatever that machine is actually for. ONNX Runtime's default is one thread
   * per core, which for this model buys very little past four.
   */
  readonly threads?: number | undefined;
}

/** The shape of the pieces of `onnxruntime-node` this module uses. */
interface OrtTensorLike {
  readonly data: unknown;
  readonly dims: readonly number[];
}
interface OrtSessionLike {
  readonly outputNames: readonly string[];
  readonly inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  release(): Promise<void>;
}

/** The output every sentence-transformers export of this model produces. */
const HIDDEN_STATE = 'last_hidden_state';

/** Opens an inference session over a verified model file. */
export async function openSession(
  modelPath: string,
  options: SessionOptions = {},
): Promise<EmbeddingSession> {
  const ort = await import('onnxruntime-node');

  // In `agentfuse wrap` this process's stdout is the agent's JSON-RPC stream.
  // ONNX Runtime logs to stderr, but a future warning that went the other way
  // would corrupt every frame after it, so the runtime is told to say nothing
  // short of an error in the first place.
  ort.env.logLevel = 'error';

  const threads = options.threads ?? defaultThreads();
  const session = (await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    logSeverityLevel: 3,
  })) as unknown as OrtSessionLike;

  if (!session.outputNames.includes(HIDDEN_STATE)) {
    await session.release();
    throw new Error(
      `${modelPath} has outputs [${session.outputNames.join(', ')}] but no ${HIDDEN_STATE}; ` +
        'this package pools token embeddings and cannot use a model that only exposes a pooled output',
    );
  }

  const inputs = new Set(session.inputNames);
  let released = false;

  return {
    async run(batch: EncodedBatch): Promise<Float32Array> {
      const dims = [batch.rows, batch.length];
      const feeds: Record<string, unknown> = {
        input_ids: new ort.Tensor('int64', batch.ids, dims),
        attention_mask: new ort.Tensor('int64', batch.mask, dims),
      };
      // Some exports of this checkpoint drop `token_type_ids` because a
      // single-sequence input always has it zero. Feeding an input the graph
      // does not declare is an error, so it is offered only if asked for.
      if (inputs.has('token_type_ids')) {
        feeds.token_type_ids = new ort.Tensor('int64', batch.typeIds, dims);
      }

      const output = (await session.run(feeds))[HIDDEN_STATE];
      if (output === undefined || !(output.data instanceof Float32Array)) {
        throw new Error(`${HIDDEN_STATE} came back as something other than a float32 tensor`);
      }
      return output.data;
    },
    async close(): Promise<void> {
      if (released) return;
      released = true;
      await session.release();
    },
  };
}

/**
 * At most four threads, and never more than the machine has.
 *
 * `availableParallelism` rather than `cpus().length`: it honours cgroup CPU
 * limits, and this package runs in containers where the two differ by an order
 * of magnitude.
 */
export function defaultThreads(): number {
  return Math.max(1, Math.min(4, availableParallelism()));
}
