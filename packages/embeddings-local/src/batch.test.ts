import { describe, expect, it } from 'vitest';
import { type EncodedBatch, type Encoding, meanPool, packBatch } from './batch.js';

const SPECIAL = { sep: 102, pad: 0 } as const;

function encoding(ids: number[], mask?: number[], types?: number[]): Encoding {
  return {
    ids,
    attention_mask: mask ?? ids.map(() => 1),
    ...(types !== undefined ? { token_type_ids: types } : undefined),
  };
}

/** Row-major read-back, so the assertions below talk about rows, not offsets. */
function row(batch: EncodedBatch, array: BigInt64Array, index: number): number[] {
  return [...array.slice(index * batch.length, (index + 1) * batch.length)].map(Number);
}

describe('packBatch', () => {
  it('pads every row to the longest one and masks the padding out', () => {
    const batch = packBatch([encoding([101, 7592, 102]), encoding([101, 102])], 256, SPECIAL);

    expect(batch.rows).toBe(2);
    expect(batch.length).toBe(3);
    expect(row(batch, batch.ids, 0)).toEqual([101, 7592, 102]);
    expect(row(batch, batch.mask, 0)).toEqual([1, 1, 1]);
    expect(row(batch, batch.ids, 1)).toEqual([101, 102, SPECIAL.pad]);
    expect(row(batch, batch.mask, 1)).toEqual([1, 1, 0]);
  });

  it('pads to the batch, not to the model maximum', () => {
    // Padding to `maxTokens` would be correct and would multiply the runtime's
    // work by the ratio of the longest possible text to the typical one.
    expect(packBatch([encoding([101, 102])], 256, SPECIAL).length).toBe(2);
  });

  it('truncates to maxTokens and keeps the final separator', () => {
    const long = encoding([101, 1, 2, 3, 4, 5, 102]);
    const batch = packBatch([long], 4, SPECIAL);

    expect(batch.length).toBe(4);
    // `[CLS] 1 2 [SEP]` — the tail is dropped, the separator is not. A model
    // whose every training sequence ended in [SEP] is not given one that does
    // not.
    expect(row(batch, batch.ids, 0)).toEqual([101, 1, 2, SPECIAL.sep]);
    expect(row(batch, batch.mask, 0)).toEqual([1, 1, 1, 1]);
  });

  it('leaves a row that exactly fits untouched', () => {
    const batch = packBatch([encoding([101, 1, 2, 102])], 4, SPECIAL);
    expect(row(batch, batch.ids, 0)).toEqual([101, 1, 2, 102]);
  });

  it('carries token_type_ids through and defaults them to zero', () => {
    const batch = packBatch(
      [encoding([101, 5, 102], undefined, [0, 1, 1]), encoding([101, 102])],
      256,
      SPECIAL,
    );

    expect(row(batch, batch.typeIds, 0)).toEqual([0, 1, 1]);
    expect(row(batch, batch.typeIds, 1)).toEqual([0, 0, 0]);
  });

  it('honours an attention mask the tokenizer already zeroed', () => {
    const batch = packBatch([encoding([101, 5, 102], [1, 0, 1])], 256, SPECIAL);
    expect(row(batch, batch.mask, 0)).toEqual([1, 0, 1]);
  });

  it('produces a usable shape for an empty batch', () => {
    const batch = packBatch([], 256, SPECIAL);
    expect(batch.rows).toBe(0);
    // Not zero: a zero-length dimension is a shape some runtimes reject.
    expect(batch.length).toBe(1);
    expect(batch.ids).toHaveLength(0);
  });
});

describe('meanPool', () => {
  /** `[rows, length, dims]` flattened, written as nested arrays for legibility. */
  function hidden(rows: number[][][]): Float32Array {
    return Float32Array.from(rows.flat(2));
  }

  const batch = (mask: number[][], length: number): EncodedBatch => ({
    ids: new BigInt64Array(mask.length * length),
    mask: BigInt64Array.from(mask.flat().map(BigInt)),
    typeIds: new BigInt64Array(mask.length * length),
    rows: mask.length,
    length,
  });

  it('averages only the unmasked positions and returns a unit vector', () => {
    const vectors = meanPool(
      hidden([
        [
          [3, 4],
          [3, 4],
          [1000, -1000],
        ],
      ]),
      batch([[1, 1, 0]], 3),
      2,
    );

    // mean = (3, 4), ‖·‖ = 5. The padded position holds a value that would be
    // impossible to miss if it leaked in.
    expect([...(vectors[0] as Float32Array)]).toEqual([
      expect.closeTo(0.6, 6),
      expect.closeTo(0.8, 6),
    ]);
  });

  it('gives the same vector whether or not the row was padded', () => {
    // The padding must be invisible, not merely small: the same text embedded
    // alone and embedded beside a longer one has to land in the same place, or
    // the window score would depend on how the queue happened to group calls.
    const padded = meanPool(
      hidden([
        [
          [1, 2],
          [3, 4],
          [-99, 99],
        ],
      ]),
      batch([[1, 1, 0]], 3),
      2,
    );
    const tight = meanPool(
      hidden([
        [
          [1, 2],
          [3, 4],
        ],
      ]),
      batch([[1, 1]], 2),
      2,
    );

    expect([...(padded[0] as Float32Array)]).toEqual([...(tight[0] as Float32Array)]);
  });

  it('pools each row independently', () => {
    const vectors = meanPool(
      hidden([
        [
          [1, 0],
          [1, 0],
        ],
        [
          [0, -3],
          [7, 7],
        ],
      ]),
      batch(
        [
          [1, 1],
          [1, 0],
        ],
        2,
      ),
      2,
    );

    expect([...(vectors[0] as Float32Array)]).toEqual([1, 0]);
    expect([...(vectors[1] as Float32Array)]).toEqual([0, -1]);
  });

  it('gives a fully masked row its own direction rather than NaN', () => {
    // A zero vector would make every cosine against it NaN and poison the whole
    // detector window, so it gets a basis direction instead — the same choice
    // `HashingProvider` makes for the empty string.
    const vectors = meanPool(
      hidden([
        [
          [5, 5],
          [5, 5],
        ],
      ]),
      batch([[0, 0]], 2),
      2,
    );

    expect([...(vectors[0] as Float32Array)]).toEqual([1, 0]);
  });

  it('gives an all-zero hidden state a direction too', () => {
    const vectors = meanPool(hidden([[[0, 0]]]), batch([[1]], 1), 2);
    expect([...(vectors[0] as Float32Array)]).toEqual([1, 0]);
  });

  it('returns unit vectors for arbitrary hidden states', () => {
    const rows = 4;
    const dims = 8;
    const values: number[][][] = [];
    // A seeded LCG, so the case is a property rather than one lucky draw and
    // still reproduces exactly. `Math.random()` would make a failure a rumour.
    let seed = 20260916;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000 - 0.5;
    };
    for (let r = 0; r < rows; r += 1) {
      values.push([
        Array.from({ length: dims }, next),
        Array.from({ length: dims }, next),
        Array.from({ length: dims }, next),
      ]);
    }

    const vectors = meanPool(
      hidden(values),
      batch(
        [
          [1, 1, 1],
          [1, 1, 0],
          [1, 0, 0],
          [1, 1, 1],
        ],
        3,
      ),
      dims,
    );

    expect(vectors).toHaveLength(rows);
    for (const vector of vectors) {
      let norm = 0;
      for (const value of vector) norm += value * value;
      expect(norm).toBeCloseTo(1, 6);
    }
  });
});
