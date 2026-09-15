import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EmbeddingWindow } from './window.js';

/**
 * The scorer is the one piece of AgentFuse that is pure numerics, so it is
 * tested the way numerics are: against a naive reference implementation, over
 * randomised input, with the floating-point error budget written down.
 *
 * Nothing here uses `Math.random()`. `fast-check` is seeded, and the
 * hand-rolled generator below is a plain LCG, so a failure is reproducible.
 */

/** Mean pairwise cosine similarity, computed the expensive honest way. */
function naiveScore(vectors: readonly Float32Array[]): number {
  const w = vectors.length;
  let total = 0;
  for (let i = 0; i < w; i += 1) {
    for (let j = i + 1; j < w; j += 1) {
      const a = vectors[i] as Float32Array;
      const b = vectors[j] as Float32Array;
      let dot = 0;
      for (let k = 0; k < a.length; k += 1) dot += (a[k] as number) * (b[k] as number);
      total += dot;
    }
  }
  return total / ((w * (w - 1)) / 2);
}

/**
 * A 32-bit LCG. Deterministic and seeded, because `Math.random()` is banned in
 * this package and a numeric test that cannot be replayed is not a test.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** An L2-normalized vector, as {@link EmbeddingProvider} promises to produce. */
function unit(dims: number, next: () => number): Float32Array {
  const out = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i += 1) {
    const value = next() * 2 - 1;
    out[i] = value;
    norm += value * value;
  }
  // A random vector is never exactly zero here, but a guard costs nothing and
  // a NaN in a similarity score is the hardest kind of bug to trace back.
  const scale = norm === 0 ? 0 : 1 / Math.sqrt(norm);
  for (let i = 0; i < dims; i += 1) out[i] = (out[i] as number) * scale;
  return out;
}

/** Sums vectors from scratch, the way `#recompute` does internally. */
function freshSum(vectors: readonly Float32Array[], dims: number): Float64Array {
  const sum = new Float64Array(dims);
  for (const vector of vectors) {
    for (let i = 0; i < dims; i += 1) sum[i] = (sum[i] as number) + (vector[i] as number);
  }
  return sum;
}

describe('EmbeddingWindow — construction', () => {
  it('rejects a non-positive or fractional capacity', () => {
    expect(() => new EmbeddingWindow({ capacity: 0, dims: 4 })).toThrow(RangeError);
    expect(() => new EmbeddingWindow({ capacity: 2.5, dims: 4 })).toThrow(RangeError);
  });

  it('rejects a non-positive or fractional width', () => {
    expect(() => new EmbeddingWindow({ capacity: 4, dims: 0 })).toThrow(RangeError);
    expect(() => new EmbeddingWindow({ capacity: 4, dims: 1.5 })).toThrow(RangeError);
  });

  it('reports its geometry', () => {
    const window = new EmbeddingWindow({ capacity: 8, dims: 16 });
    expect(window.capacity).toBe(8);
    expect(window.dims).toBe(16);
    expect(window.size).toBe(0);
  });

  it('refuses a vector of the wrong width', () => {
    const window = new EmbeddingWindow({ capacity: 4, dims: 3 });
    expect(() => window.push(new Float32Array(4))).toThrow(RangeError);
  });
});

describe('EmbeddingWindow — occupancy gate', () => {
  it('has no score for fewer than two vectors', () => {
    const window = new EmbeddingWindow({ capacity: 4, dims: 2 });
    expect(window.score()).toBeNull();
    window.push(new Float32Array([1, 0]));
    expect(window.score()).toBeNull();
  });

  it('has no score below the requested minimum occupancy', () => {
    const window = new EmbeddingWindow({ capacity: 8, dims: 2 });
    for (let i = 0; i < 3; i += 1) window.push(new Float32Array([1, 0]));
    expect(window.score(5)).toBeNull();
    expect(window.score(3)).not.toBeNull();
  });

  it('falls back to the minimum given at construction', () => {
    const window = new EmbeddingWindow({ capacity: 8, dims: 2, minCalls: 4 });
    for (let i = 0; i < 3; i += 1) window.push(new Float32Array([1, 0]));
    expect(window.score()).toBeNull();
    window.push(new Float32Array([1, 0]));
    expect(window.score()).toBeCloseTo(1, 12);
  });
});

describe('EmbeddingWindow — the closed form', () => {
  it('scores identical vectors as 1 and antipodal pairs as -1', () => {
    const same = new EmbeddingWindow({ capacity: 4, dims: 2 });
    same.push(new Float32Array([1, 0]));
    same.push(new Float32Array([1, 0]));
    expect(same.score()).toBeCloseTo(1, 12);

    const opposed = new EmbeddingWindow({ capacity: 4, dims: 2 });
    opposed.push(new Float32Array([1, 0]));
    opposed.push(new Float32Array([-1, 0]));
    expect(opposed.score()).toBeCloseTo(-1, 12);
  });

  it('scores orthogonal vectors as 0', () => {
    const window = new EmbeddingWindow({ capacity: 4, dims: 2 });
    window.push(new Float32Array([1, 0]));
    window.push(new Float32Array([0, 1]));
    expect(window.score()).toBeCloseTo(0, 12);
  });

  it('clamps a score that floating point pushed outside [-1, 1]', () => {
    // Every vector identical means the exact answer is 1, and the closed form
    // reaches it through `(‖S‖² − W) / (W(W−1))`, which overshoots by a few
    // ulps. A score of 1.0000000000000002 in a report is a bug.
    const window = new EmbeddingWindow({ capacity: 64, dims: 3 });
    const vector = unit(3, lcg(7));
    for (let i = 0; i < 64; i += 1) window.push(vector);
    const score = window.score() as number;
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeCloseTo(1, 10);
  });

  it('agrees with the naive O(W²) reference over randomised windows', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 24 }),
        fc.integer({ min: 2, max: 48 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        (capacity, dims, seed) => {
          const next = lcg(seed);
          const window = new EmbeddingWindow({ capacity, dims });
          // Overfill, so evictions — and therefore the incremental subtraction —
          // are part of what is being compared.
          for (let i = 0; i < capacity * 3; i += 1) window.push(unit(dims, next));

          const expected = naiveScore(window.vectors());
          expect(window.score(2) as number).toBeCloseTo(expected, 6);
        },
      ),
      { numRuns: 200, seed: 20260915 },
    );
  });

  it('agrees with the reference on a partially filled window too', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 16 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        (fill, seed) => {
          const next = lcg(seed);
          const window = new EmbeddingWindow({ capacity: 32, dims: 12 });
          for (let i = 0; i < fill; i += 1) window.push(unit(12, next));
          expect(window.score(2) as number).toBeCloseTo(naiveScore(window.vectors()), 6);
        },
      ),
      { numRuns: 100, seed: 20260915 },
    );
  });
});

describe('EmbeddingWindow — drift', () => {
  it('keeps the incremental sum in step with a from-scratch recompute', () => {
    // 20 000 push/evict cycles on a 16-wide window: two orders of magnitude
    // more than the periodic rebuild interval, so this exercises the rebuild as
    // well as the incremental arithmetic between rebuilds.
    const dims = 16;
    const window = new EmbeddingWindow({ capacity: 16, dims });
    const next = lcg(424242);
    for (let i = 0; i < 20_000; i += 1) window.push(unit(dims, next));

    const incremental = window.runningSum();
    const fresh = freshSum(window.vectors(), dims);
    for (let i = 0; i < dims; i += 1) {
      expect(incremental[i] as number).toBeCloseTo(fresh[i] as number, 10);
    }
    expect(window.score(2) as number).toBeCloseTo(naiveScore(window.vectors()), 6);
  });

  it('stays bounded with the periodic rebuild switched off', () => {
    // The rebuild is cheap insurance, not the thing holding the error down: a
    // Float64 accumulator fed Float32 addends drifts far too slowly to matter.
    // Pinning that separately means a future change to the interval cannot
    // silently become load-bearing.
    const dims = 8;
    const window = new EmbeddingWindow({
      capacity: 8,
      dims,
      recomputeEvery: Number.MAX_SAFE_INTEGER,
    });
    const next = lcg(99);
    for (let i = 0; i < 50_000; i += 1) window.push(unit(dims, next));

    const incremental = window.runningSum();
    const fresh = freshSum(window.vectors(), dims);
    for (let i = 0; i < dims; i += 1) {
      expect(Math.abs((incremental[i] as number) - (fresh[i] as number))).toBeLessThan(1e-9);
    }
  });

  it('rebuilds the sum on schedule', () => {
    // A tight interval, so the rebuild path is exercised deterministically
    // rather than only after ten thousand pushes.
    const window = new EmbeddingWindow({ capacity: 2, dims: 2, recomputeEvery: 1 });
    window.push(new Float32Array([1, 0]));
    window.push(new Float32Array([0, 1]));
    window.push(new Float32Array([1, 0]));
    expect([...window.runningSum()]).toEqual([1, 1]);
    expect(window.score(2) as number).toBeCloseTo(0, 12);
  });
});

describe('EmbeddingWindow — contents', () => {
  it('returns the window oldest first, and copies', () => {
    const window = new EmbeddingWindow({ capacity: 2, dims: 1 });
    window.push(new Float32Array([1]));
    window.push(new Float32Array([2]));
    window.push(new Float32Array([3]));
    expect(window.vectors().map((v) => v[0])).toEqual([2, 3]);

    const copy = window.vectors();
    (copy[0] as Float32Array)[0] = 99;
    expect(window.vectors()[0]?.[0]).toBe(2);
  });

  it('copies the running sum', () => {
    const window = new EmbeddingWindow({ capacity: 2, dims: 1 });
    window.push(new Float32Array([1]));
    const sum = window.runningSum();
    sum[0] = 99;
    expect(window.runningSum()[0]).toBe(1);
  });

  it('empties on clear', () => {
    const window = new EmbeddingWindow({ capacity: 4, dims: 2 });
    window.push(new Float32Array([1, 0]));
    window.push(new Float32Array([1, 0]));
    window.clear();
    expect(window.size).toBe(0);
    expect(window.score()).toBeNull();
    expect([...window.runningSum()]).toEqual([0, 0]);
  });
});

describe('EmbeddingWindow — resizing', () => {
  it('keeps the newest vectors when shrinking', () => {
    const window = new EmbeddingWindow({ capacity: 4, dims: 1 });
    for (const value of [1, 2, 3, 4]) window.push(new Float32Array([value]));
    window.ensureCapacity(2);
    expect(window.capacity).toBe(2);
    expect(window.vectors().map((v) => v[0])).toEqual([3, 4]);
    expect([...window.runningSum()]).toEqual([7]);
  });

  it('keeps everything when growing', () => {
    const window = new EmbeddingWindow({ capacity: 2, dims: 1 });
    for (const value of [1, 2]) window.push(new Float32Array([value]));
    window.ensureCapacity(6);
    expect(window.capacity).toBe(6);
    expect(window.vectors().map((v) => v[0])).toEqual([1, 2]);
  });

  it('is a no-op at the same capacity', () => {
    const window = new EmbeddingWindow({ capacity: 3, dims: 1 });
    window.push(new Float32Array([5]));
    window.ensureCapacity(3);
    expect(window.size).toBe(1);
  });

  it('rejects an invalid capacity', () => {
    const window = new EmbeddingWindow({ capacity: 3, dims: 1 });
    expect(() => window.ensureCapacity(0)).toThrow(RangeError);
    expect(() => window.ensureCapacity(1.5)).toThrow(RangeError);
  });
});
