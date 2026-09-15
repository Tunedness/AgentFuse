/**
 * Turning a batch of texts into the three tensors the model wants, and turning
 * the tensor it returns back into vectors.
 *
 * Both halves are pure functions over typed arrays, with no runtime and no
 * tokenizer in sight. That is deliberate: the pooling recipe is the part of
 * this package that fails *silently* when it is wrong — a mis-applied attention
 * mask still produces 384 finite numbers of unit length, and every test that
 * only checks shapes would pass while the vectors meant nothing. Phase 9 would
 * then calibrate its thresholds against noise. So the arithmetic is separated
 * from the I/O and pinned against hand-computed expectations.
 */

/** What a tokenizer hands back for one text. */
export interface Encoding {
  readonly ids: readonly number[];
  readonly attention_mask: readonly number[];
  readonly token_type_ids?: readonly number[] | undefined;
}

/** One padded batch, flattened row-major as the ONNX graph expects. */
export interface EncodedBatch {
  /** `[rows, length]` of int64 token ids. */
  readonly ids: BigInt64Array;
  /** `[rows, length]`; 1 for a real token, 0 for padding. */
  readonly mask: BigInt64Array;
  /** `[rows, length]`; all zeros for single-sequence inputs. */
  readonly typeIds: BigInt64Array;
  readonly rows: number;
  readonly length: number;
}

/** Special token ids the packer needs. */
export interface SpecialTokens {
  /** Written over the last position of a truncated row. */
  readonly sep: number;
  /** Fills the tail of a short row. Masked out, so its value never matters. */
  readonly pad: number;
}

/**
 * Packs encodings into one padded batch.
 *
 * **Truncation keeps the final `[SEP]`.** An encoding arrives as
 * `[CLS] t₁ … tₙ [SEP]`; cutting it at `maxTokens` and overwriting the last
 * position with `[SEP]` is what "longest_first" truncation does for a single
 * sequence, and it matters because BERT's post-processing — and every corpus
 * this model was trained on — puts a separator at the end of every sequence.
 * Dropping it feeds the encoder a shape it has never seen.
 *
 * **Padding is to the longest row in the batch, not to `maxTokens`.** Padded
 * positions are masked out of both attention and the pooling average, so they
 * cost time and nothing else; padding every batch to 256 would multiply the
 * runtime's work by the ratio of the longest text to the typical one.
 */
export function packBatch(
  encodings: readonly Encoding[],
  maxTokens: number,
  special: SpecialTokens,
): EncodedBatch {
  const rows = encodings.length;
  const lengths = encodings.map((encoding) => Math.min(encoding.ids.length, maxTokens));
  // `1` rather than `0` for an empty batch keeps every downstream index valid;
  // a zero-length dimension is a shape some runtimes reject outright.
  const length = Math.max(1, ...lengths);

  const ids = new BigInt64Array(rows * length);
  const mask = new BigInt64Array(rows * length);
  const typeIds = new BigInt64Array(rows * length);

  for (let row = 0; row < rows; row += 1) {
    const encoding = encodings[row] as Encoding;
    const kept = lengths[row] as number;
    const truncated = kept < encoding.ids.length;
    const base = row * length;
    for (let i = 0; i < kept; i += 1) {
      const last = truncated && i === kept - 1;
      ids[base + i] = BigInt(last ? special.sep : (encoding.ids[i] as number));
      mask[base + i] = BigInt(encoding.attention_mask[i] ?? 1);
      typeIds[base + i] = BigInt(encoding.token_type_ids?.[i] ?? 0);
    }
    for (let i = kept; i < length; i += 1) {
      ids[base + i] = BigInt(special.pad);
      // mask and typeIds are already zero; a BigInt64Array starts at 0n.
    }
  }

  return { ids, mask, typeIds, rows, length };
}

/**
 * Mean-pools the token embeddings under the attention mask, then L2-normalises.
 *
 * This is the sentence-transformers recipe for `all-MiniLM-L6-v2`, and it is
 * the only correct one for this checkpoint: the model card's own pooling
 * configuration is `pooling_mode_mean_tokens`, not CLS pooling. Using
 * `last_hidden_state[:, 0]` — the obvious-looking alternative, since that is
 * the `[CLS]` position — produces vectors that still look plausible and score
 * badly, because this checkpoint's `[CLS]` was never trained as a sentence
 * representation.
 *
 * What is load-bearing is the mask on the **sum**. The division by the token
 * count is not: L2 normalisation immediately follows, and scaling a vector by a
 * positive constant does not move it, so mean pooling and sum pooling produce
 * the same unit vector. The count is kept because it is the published recipe
 * and because it keeps the intermediate values in a sane range — but a reader
 * looking for the line that would silently ruin the vectors should look at the
 * `continue` above, not at the division.
 *
 * **L2 normalisation is not optional.** `@agentfuse/core`'s `EmbeddingProvider`
 * says so, and phase 3's closed-form window score
 * `(‖S‖² − W) / (W · (W − 1))` is only the mean pairwise cosine when every
 * vector has unit length.
 */
export function meanPool(hidden: Float32Array, batch: EncodedBatch, dims: number): Float32Array[] {
  const { rows, length, mask } = batch;
  const out: Float32Array[] = [];

  for (let row = 0; row < rows; row += 1) {
    // Accumulate in float64. The summands are float32 and there are at most
    // 256 of them, so this costs nothing and removes a question nobody should
    // have to answer about where the rounding went.
    const sum = new Float64Array(dims);
    let count = 0;
    for (let position = 0; position < length; position += 1) {
      if (mask[row * length + position] === 0n) continue;
      count += 1;
      const base = (row * length + position) * dims;
      for (let k = 0; k < dims; k += 1) sum[k] = (sum[k] as number) + (hidden[base + k] as number);
    }

    const vector = new Float32Array(dims);
    let norm = 0;
    if (count > 0) {
      for (let k = 0; k < dims; k += 1) {
        const mean = (sum[k] as number) / count;
        vector[k] = mean;
        norm += mean * mean;
      }
    }
    if (norm === 0) {
      // Reachable only for a fully masked row or a hidden state of all zeros.
      // A zero vector makes every cosine NaN and would poison the whole window,
      // so it gets its own basis direction instead — the same choice
      // `HashingProvider` makes for the empty string.
      vector[0] = 1;
      out.push(vector);
      continue;
    }
    const scale = 1 / Math.sqrt(norm);
    for (let k = 0; k < dims; k += 1) vector[k] = (vector[k] as number) * scale;
    out.push(vector);
  }

  return out;
}
