/**
 * `@agentfuse/core`'s `EmbeddingProvider`, implemented over a real model.
 *
 * The provider is written against two seams — a {@link Tokenizing} and an
 * {@link EmbeddingSession} — rather than against `@huggingface/tokenizers` and
 * `onnxruntime-node` directly. That is what lets the batching, the truncation,
 * the pooling, the close semantics and every error path be tested by a suite
 * that downloads nothing and loads no native code; the parts that genuinely
 * need the model are a handful of end-to-end cases that skip when it is not
 * cached.
 *
 * The session is created once and reused for the life of the provider. Creating
 * one costs roughly a hundred milliseconds of graph optimisation and a resident
 * copy of the weights, and phase 3's queue calls `embed()` once per batch for
 * the whole run of the proxy.
 */

import type { EmbeddingProvider } from '@agentfuse/core';
import { type Encoding, meanPool, packBatch, type SpecialTokens } from './batch.js';
import type { ModelSpec } from './models.js';
import type { EmbeddingSession } from './session.js';

/** The part of a tokenizer this package uses. */
export interface Tokenizing {
  encode(text: string, options: { return_token_type_ids: true }): Encoding;
}

/** What {@link LocalEmbeddingProvider} is built from. */
export interface ProviderParts {
  readonly spec: ModelSpec;
  readonly tokenizer: Tokenizing;
  readonly session: EmbeddingSession;
  readonly special: SpecialTokens;
}

/**
 * A local, on-device {@link EmbeddingProvider}.
 *
 * Its vectors are L2-normalised, which core's port requires and phase 3's
 * closed-form window score depends on — see {@link meanPool}.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dims: number;

  readonly #spec: ModelSpec;
  readonly #tokenizer: Tokenizing;
  readonly #session: EmbeddingSession;
  readonly #special: SpecialTokens;
  #closed = false;

  constructor(parts: ProviderParts) {
    this.#spec = parts.spec;
    this.#tokenizer = parts.tokenizer;
    this.#session = parts.session;
    this.#special = parts.special;
    this.id = parts.spec.providerId;
    this.dims = parts.spec.dims;
  }

  /**
   * Embeds a batch.
   *
   * Phase 3's queue hands over up to eight texts at a time and they are run as
   * one graph execution: the per-call cost of this model is dominated by the
   * fixed overhead of crossing into the runtime, so eight texts in one call are
   * far cheaper than eight calls.
   *
   * **Batch composition perturbs the vectors slightly, and that is the model's
   * doing, not ours.** `model_quantized.onnx` is dynamically quantised: the
   * activation scale is derived from the whole input tensor, so a text embedded
   * beside different neighbours comes back a little different — measured at
   * cosine ≥ 0.998 against the same text embedded alone. The same text in the
   * same batch is bit-identical. Anything calibrating a threshold on these
   * vectors should treat ±0.002 as the floor of what a score means.
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.#closed) {
      throw new Error(`${this.id} has been closed; create a new provider to embed again`);
    }
    if (texts.length === 0) return [];

    const encodings = texts.map((text) =>
      this.#tokenizer.encode(text, { return_token_type_ids: true }),
    );
    const batch = packBatch(encodings, this.#spec.maxTokens, this.#special);
    const hidden = await this.#session.run(batch);

    const expected = batch.rows * batch.length * this.dims;
    if (hidden.length !== expected) {
      throw new Error(
        `${this.id} returned ${hidden.length} floats for a ${batch.rows}×${batch.length} batch, expected ${expected}`,
      );
    }
    return meanPool(hidden, batch, this.dims);
  }

  /** Releases the native session. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#session.close();
  }
}
