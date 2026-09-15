import type { EmbeddingProvider } from '../ports/index.js';

/**
 * A deterministic {@link EmbeddingProvider} built out of character trigrams.
 *
 * **This is a test double, not an embedding model. Never configure it as a
 * production provider.** It knows nothing about meaning: it hashes overlapping
 * three-character windows into a fixed number of buckets and normalizes the
 * result. Two texts that share most of their characters score high; two that do
 * not score near zero. That is enough to exercise every line of the semantic
 * layer, and it is nothing like what `all-MiniLM-L6-v2` does.
 *
 * Its reason to exist is CI. ADR-003 moved the ONNX runtime into an optional
 * companion package precisely because `onnxruntime-node` unpacks to ~301 MB;
 * requiring that download in order to run the tests for the layer that consumes
 * it would undo the decision. With this double the whole semantic layer —
 * queue, window, detector, breaker hand-off — is covered by a test run that
 * installs nothing.
 *
 * The honesty of the double is itself tested: see the "behaves plausibly" cases
 * in `hashing-provider.test.ts`. If a change here made near-identical texts
 * score low, every semantic test would still pass while testing nothing, so the
 * property is pinned separately.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a over three char codes. Cheap, well-mixed, and dependency-free. */
function trigramHash(a: number, b: number, c: number): number {
  let h = FNV_OFFSET;
  h = Math.imul(h ^ a, FNV_PRIME);
  h = Math.imul(h ^ b, FNV_PRIME);
  h = Math.imul(h ^ c, FNV_PRIME);
  return h >>> 0;
}

/** Default width. Wide enough that unrelated texts land near-orthogonal. */
const DEFAULT_DIMS = 256;

/**
 * Sentinels wrapped around the text, so that a one-character input still
 * produces a trigram and so that the first and last characters carry position
 * signal. Built from char codes rather than written literally: STX and ETX are
 * invisible in an editor, and an invisible constant is an unreviewable one.
 */
const START = String.fromCharCode(0x02);
const END = String.fromCharCode(0x03);

/** A hashing-trick stand-in for a real embedding model. See the module doc. */
export class HashingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dims: number;

  constructor(dims: number = DEFAULT_DIMS) {
    if (!Number.isInteger(dims) || dims < 2) {
      throw new RangeError(`dims must be an integer of at least 2, got ${dims}`);
    }
    this.dims = dims;
    this.id = `test:hashing-trigram-${dims}`;
  }

  /** Embeds a batch. Always resolves; the double has nothing to fail at. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.vector(text));
  }

  /**
   * The L2-normalized vector for one text.
   *
   * Synchronous, so a test that wants to reason about the geometry directly
   * does not have to go through a promise.
   */
  vector(text: string): Float32Array {
    const out = new Float32Array(this.dims);
    const padded = `${START}${text.toLowerCase()}${END}`;

    for (let i = 0; i + 2 < padded.length; i += 1) {
      const h = trigramHash(
        padded.charCodeAt(i),
        padded.charCodeAt(i + 1),
        padded.charCodeAt(i + 2),
      );
      const index = h % this.dims;
      // The sign comes from a bit the bucket index does not use, so collisions
      // cancel as often as they reinforce and unrelated texts stay near
      // orthogonal instead of all drifting positive.
      const sign = h >>> 31 === 1 ? -1 : 1;
      out[index] = (out[index] as number) + sign;
    }

    let norm = 0;
    for (const value of out) norm += value * value;
    if (norm === 0) {
      // Only reachable for the empty string, which has no trigrams. A zero
      // vector would make every cosine NaN, so give it its own basis direction.
      out[0] = 1;
      return out;
    }

    const scale = 1 / Math.sqrt(norm);
    for (let i = 0; i < out.length; i += 1) out[i] = (out[i] as number) * scale;
    return out;
  }
}
