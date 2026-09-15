/**
 * The sliding-window semantic score, in closed form.
 *
 * The quantity the semantic rule is built on is the **mean pairwise cosine
 * similarity** of the last `W` tool calls. Computed naively that is `W(W−1)/2`
 * dot products of width `d` on every single call — `O(W²·d)`.
 *
 * For L2-normalized vectors it collapses to one running sum. With
 * `S = Σᵢ eᵢ`:
 *
 * ```
 * ‖S‖² = Σᵢ Σⱼ eᵢ·eⱼ = Σᵢ ‖eᵢ‖² + 2 Σᵢ<ⱼ eᵢ·eⱼ = W + 2 Σᵢ<ⱼ eᵢ·eⱼ
 * ```
 *
 * so the mean over the `W(W−1)/2` distinct pairs is
 *
 * ```
 * score = (‖S‖² − W) / (W · (W − 1))
 * ```
 *
 * Maintaining `S` incrementally — add on push, subtract on evict — makes
 * scoring **`O(d)` per call**. That is what lets the scorer keep up with a busy
 * agent on one worker, and it is why the window stores vectors at all rather
 * than only their sum: an eviction needs the vector that is leaving.
 *
 * **The vectors must be L2-normalized.** {@link EmbeddingProvider} says so in
 * its contract; feed it anything else and the identity above stops holding and
 * the score becomes meaningless rather than merely inaccurate.
 */

/**
 * Reads a typed array at an index the caller has already proved is in bounds.
 *
 * `noUncheckedIndexedAccess` types every typed-array read as `number |
 * undefined`, which is the right default and the wrong one inside a numeric
 * kernel whose loop bounds are the proof. One narrow helper is better than a
 * `?? 0` on every term, which would silently paper over a real out-of-bounds
 * read instead of crashing on it.
 */
function at(array: Float32Array | Float64Array, index: number): number {
  return array[index] as number;
}

/** Options for {@link EmbeddingWindow}. */
export interface EmbeddingWindowOptions {
  /** How many vectors the window holds. Comes from `loop_detection.window`. */
  capacity: number;
  /** Vector width. Comes from `EmbeddingProvider.dims`. */
  dims: number;
  /**
   * Default minimum occupancy before {@link EmbeddingWindow.score} answers.
   * Comes from `loop_detection.min_calls`.
   */
  minCalls?: number;
  /** Evictions between full recomputations of the running sum. */
  recomputeEvery?: number;
}

/**
 * How many evictions may pass before `S` is rebuilt from the stored vectors.
 *
 * The accumulator is `Float64Array` fed with `Float32` addends, so one
 * add/subtract pair loses at most ~2⁻⁵³ of relative precision and a thousand of
 * them cannot move a score by anything close to the 1e-3 granularity of a
 * threshold anyone would configure. 1024 is therefore chosen for cheapness
 * rather than necessity: a rebuild is `O(W·d)` and, amortised over 1024 pushes
 * with `W ≤ 64`, costs well under one extra addition per push. It also bounds
 * the damage if a provider ever hands over a denormal or a vector that is not
 * quite unit length, which no amount of careful arithmetic here would catch.
 */
const DEFAULT_RECOMPUTE_EVERY = 1024;

/**
 * A fixed-capacity ring of embeddings that knows its own mean pairwise
 * similarity.
 *
 * Storage is one flat `Float32Array` of `capacity × dims` rather than an array
 * of vectors: a session's window is allocated once and never produces garbage
 * per call, which matters because there is one of these per live session.
 */
export class EmbeddingWindow {
  #capacity: number;
  readonly #dims: number;
  readonly #minCalls: number;
  readonly #recomputeEvery: number;
  #buffer: Float32Array;
  readonly #sum: Float64Array;
  #count = 0;
  /** Slot the next push writes to. */
  #head = 0;
  #sinceRecompute = 0;

  constructor(options: EmbeddingWindowOptions) {
    const { capacity, dims } = options;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`window capacity must be a positive integer, got ${capacity}`);
    }
    if (!Number.isInteger(dims) || dims < 1) {
      throw new RangeError(`embedding dims must be a positive integer, got ${dims}`);
    }
    this.#capacity = capacity;
    this.#dims = dims;
    this.#minCalls = options.minCalls ?? 2;
    this.#recomputeEvery = options.recomputeEvery ?? DEFAULT_RECOMPUTE_EVERY;
    this.#buffer = new Float32Array(capacity * dims);
    this.#sum = new Float64Array(dims);
  }

  /** How many vectors the window currently holds. */
  get size(): number {
    return this.#count;
  }

  /** How many it can hold. */
  get capacity(): number {
    return this.#capacity;
  }

  /** Vector width. */
  get dims(): number {
    return this.#dims;
  }

  /**
   * Adds a vector, evicting the oldest when the window is full.
   *
   * @throws {RangeError} when the vector's width is not this window's `dims` —
   * loudly, because a silent dimension mismatch would produce a plausible-looking
   * score from two different embedding models and trip a breaker on nonsense.
   */
  push(vector: Float32Array): void {
    const dims = this.#dims;
    if (vector.length !== dims) {
      throw new RangeError(`expected a ${dims}-dimensional vector, got ${vector.length}`);
    }

    const offset = this.#head * dims;
    const buffer = this.#buffer;
    const sum = this.#sum;

    if (this.#count === this.#capacity) {
      for (let i = 0; i < dims; i += 1) sum[i] = at(sum, i) - at(buffer, offset + i);
      this.#sinceRecompute += 1;
    } else {
      this.#count += 1;
    }

    for (let i = 0; i < dims; i += 1) {
      const value = at(vector, i);
      buffer[offset + i] = value;
      sum[i] = at(sum, i) + value;
    }

    this.#head = (this.#head + 1) % this.#capacity;
    if (this.#sinceRecompute >= this.#recomputeEvery) this.#recompute();
  }

  /**
   * Mean pairwise cosine similarity over the window, or `null` when there is
   * not enough of it yet.
   *
   * @param minCalls Minimum occupancy, defaulting to the constructor's. Passed
   * per call because `loop_detection.min_calls` can be overridden per rule, and
   * the window outlives any one rule match.
   */
  score(minCalls: number = this.#minCalls): number | null {
    const w = this.#count;
    // A lone vector has no pair to be similar to; the closed form divides by
    // `W(W−1)` and would hand back an Infinity for it.
    if (w < 2 || w < minCalls) return null;

    let normSquared = 0;
    for (const value of this.#sum) normSquared += value * value;

    // Floating point can push a mathematically-in-range result a few ulps
    // outside [-1, 1]; a score of 1.0000000000000002 compared against a
    // threshold is harmless, but one that escapes into a report is not.
    return Math.min(1, Math.max(-1, (normSquared - w) / (w * (w - 1))));
  }

  /** The window's contents, oldest first. Copies, so callers cannot corrupt it. */
  vectors(): Float32Array[] {
    const out: Float32Array[] = [];
    for (let i = 0; i < this.#count; i += 1) out.push(this.#view(i).slice());
    return out;
  }

  /**
   * The incrementally maintained sum vector.
   *
   * Exposed so the drift test can hold it against a freshly computed sum — the
   * one property of this class that cannot be checked through {@link score}
   * alone, because a drifting `S` and an honest one agree to many digits right
   * up until they do not.
   */
  runningSum(): Float64Array {
    return this.#sum.slice();
  }

  /**
   * Changes the capacity, keeping the newest vectors that still fit.
   *
   * Needed because `loop_detection.window` is overridable per rule, so a session
   * that touches two differently-configured tools can ask for two window sizes.
   * Resizing rather than restarting keeps the history that has already been paid
   * for; it is `O(W·d)` and happens only when the size actually changes.
   */
  ensureCapacity(capacity: number): void {
    if (capacity === this.#capacity) return;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`window capacity must be a positive integer, got ${capacity}`);
    }
    const kept = this.vectors().slice(-capacity);
    this.#capacity = capacity;
    this.#buffer = new Float32Array(capacity * this.#dims);
    this.#count = 0;
    this.#head = 0;
    this.#sum.fill(0);
    this.#sinceRecompute = 0;
    for (const vector of kept) this.push(vector);
  }

  /** Empties the window. Used when the breaker closes and the history is moot. */
  clear(): void {
    this.#count = 0;
    this.#head = 0;
    this.#sum.fill(0);
    this.#buffer.fill(0);
    this.#sinceRecompute = 0;
  }

  // -------------------------------------------------------------------------

  /** A live view of the `index`-th oldest slot. Internal: aliases the buffer. */
  #view(index: number): Float32Array {
    const dims = this.#dims;
    const oldest = (this.#head - this.#count + this.#capacity) % this.#capacity;
    const slot = (oldest + index) % this.#capacity;
    return this.#buffer.subarray(slot * dims, slot * dims + dims);
  }

  /** Rebuilds `S` from the stored vectors, discarding accumulated drift. */
  #recompute(): void {
    const dims = this.#dims;
    const sum = this.#sum;
    sum.fill(0);
    for (let v = 0; v < this.#count; v += 1) {
      const vector = this.#view(v);
      for (let i = 0; i < dims; i += 1) sum[i] = at(sum, i) + at(vector, i);
    }
    this.#sinceRecompute = 0;
  }
}
