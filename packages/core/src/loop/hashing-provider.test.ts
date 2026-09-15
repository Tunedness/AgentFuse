import { describe, expect, it } from 'vitest';
import { HashingProvider } from './hashing-provider.js';

/**
 * The double's own honesty is under test here.
 *
 * Every semantic test in the suite reads similarity through this provider. If a
 * change made near-identical texts score low, those tests would still pass
 * while testing nothing at all — the queue would embed, the window would score,
 * and no threshold would ever be crossed. So the properties the rest of the
 * suite silently relies on are pinned right here.
 */

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

function norm(vector: Float32Array): number {
  let total = 0;
  for (const value of vector) total += value * value;
  return Math.sqrt(total);
}

describe('HashingProvider — contract', () => {
  it('names itself and its width', () => {
    const provider = new HashingProvider(64);
    expect(provider.dims).toBe(64);
    expect(provider.id).toBe('test:hashing-trigram-64');
  });

  it('defaults to 256 dimensions', () => {
    expect(new HashingProvider().dims).toBe(256);
  });

  it('rejects a width it cannot spread over', () => {
    expect(() => new HashingProvider(1)).toThrow(RangeError);
    expect(() => new HashingProvider(8.5)).toThrow(RangeError);
  });

  it('embeds a batch in order', async () => {
    const provider = new HashingProvider(32);
    const vectors = await provider.embed(['alpha', 'beta', 'alpha']);
    expect(vectors).toHaveLength(3);
    expect(cosine(vectors[0] as Float32Array, vectors[2] as Float32Array)).toBeCloseTo(1, 6);
    expect([...(vectors[0] as Float32Array)]).not.toEqual([...(vectors[1] as Float32Array)]);
  });

  it('embeds an empty batch', async () => {
    expect(await new HashingProvider(8).embed([])).toEqual([]);
  });

  it('is deterministic', () => {
    const provider = new HashingProvider(64);
    expect([...provider.vector('fs__read_file\n{"path":"/etc/hosts"}')]).toEqual([
      ...provider.vector('fs__read_file\n{"path":"/etc/hosts"}'),
    ]);
  });

  it('produces L2-normalized vectors, as the port requires', () => {
    const provider = new HashingProvider(128);
    for (const text of ['', 'a', 'ab', 'abc', 'the quick brown fox', '{"a":[1,2,3]}'.repeat(40)]) {
      expect(norm(provider.vector(text))).toBeCloseTo(1, 5);
    }
  });

  it('gives the empty string a real direction rather than a NaN factory', () => {
    // No trigrams means a zero vector, and a zero vector makes every cosine in
    // the window NaN — which would silently disable the detector instead of
    // failing loudly.
    const vector = new HashingProvider(16).vector('');
    expect(norm(vector)).toBeCloseTo(1, 6);
    expect(cosine(vector, vector)).toBeCloseTo(1, 6);
  });
});

describe('HashingProvider — behaves plausibly', () => {
  const provider = new HashingProvider(256);

  it('scores a text against itself as 1', () => {
    const vector = provider.vector('read_file {"path":"/var/log/app.log"}');
    expect(cosine(vector, vector)).toBeCloseTo(1, 6);
  });

  it('is case-insensitive', () => {
    expect(cosine(provider.vector('Read_File'), provider.vector('read_file'))).toBeCloseTo(1, 6);
  });

  it('scores near-identical texts high — this is what the detector fires on', () => {
    const a = provider.vector('fs__read_file\n{"path":"/etc/hosts"}\nresult: not found');
    const b = provider.vector('fs__read_file\n{"path":"/etc/hostz"}\nresult: not found');
    expect(cosine(a, b)).toBeGreaterThan(0.9);
  });

  it('scores unrelated texts low — this is what keeps it from firing', () => {
    const a = provider.vector('github__create_pull_request\n{"title":"Ship the parser"}');
    const b = provider.vector('sql__query\n{"statement":"SELECT 1"}');
    expect(cosine(a, b)).toBeLessThan(0.3);
  });

  it('separates a successful call from the same call failing', () => {
    const ok = provider.vector('fs__read_file\n{"path":"/a"}\nresult: contents of a');
    const bad = provider.vector('fs__read_file\n{"path":"/a"}\nresult: ERROR(ENOENT): missing');
    expect(cosine(ok, bad)).toBeLessThan(cosine(ok, ok));
  });
});
