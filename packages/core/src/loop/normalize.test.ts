import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { argsPreview, MASKS, maskString, normalizeArgs, truncateValue } from './normalize.js';

const NOW = 1_700_000_000_000;

/** Re-normalizing a canonical form must be a no-op. */
function renormalize(text: string): string {
  return normalizeArgs(JSON.parse(text) as unknown, NOW);
}

describe('normalizeArgs — canonical form', () => {
  it('sorts object keys', () => {
    expect(normalizeArgs({ b: 1, a: 2 }, NOW)).toBe('{"a":2,"b":1}');
  });

  it('sorts keys at every depth', () => {
    expect(normalizeArgs({ z: { y: 1, x: 2 } }, NOW)).toBe('{"z":{"x":2,"y":1}}');
  });

  it('preserves array order, because order is semantic', () => {
    expect(normalizeArgs(['b', 'a'], NOW)).toBe('["b","a"]');
    expect(normalizeArgs(['b', 'a'], NOW)).not.toBe(normalizeArgs(['a', 'b'], NOW));
  });

  it('does not let integer-like keys reorder the output', () => {
    // `JSON.stringify` hoists "0"/"1" ahead of "a"; the canonical serialiser
    // must not, or two identical payloads could fingerprint differently.
    expect(normalizeArgs({ a: 1, '2': 2, '10': 3 }, NOW)).toBe('{"10":3,"2":2,"a":1}');
  });

  it('collapses NaN and Infinity to null', () => {
    expect(normalizeArgs({ a: Number.NaN, b: Number.POSITIVE_INFINITY }, NOW)).toBe(
      '{"a":null,"b":null}',
    );
  });

  it('handles primitives and nullish input at the top level', () => {
    expect(normalizeArgs(undefined, NOW)).toBe('null');
    expect(normalizeArgs(null, NOW)).toBe('null');
    expect(normalizeArgs(true, NOW)).toBe('true');
    expect(normalizeArgs(7, NOW)).toBe('7');
  });
});

describe('normalizeArgs — value masking', () => {
  it('masks UUIDs', () => {
    expect(normalizeArgs({ id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }, NOW)).toBe(
      `{"id":"${MASKS.uuid}"}`,
    );
  });

  it('masks ISO-8601 timestamps', () => {
    expect(normalizeArgs({ at: '2026-09-15T14:03:22.114Z' }, NOW)).toBe(`{"at":"${MASKS.ts}"}`);
  });

  it('masks epoch integers near now, in strings and in numbers', () => {
    expect(normalizeArgs({ t: String(NOW) }, NOW)).toBe(`{"t":"${MASKS.epoch}"}`);
    expect(normalizeArgs({ t: NOW }, NOW)).toBe(`{"t":"${MASKS.epoch}"}`);
    expect(normalizeArgs({ t: Math.floor(NOW / 1000) }, NOW)).toBe(`{"t":"${MASKS.epoch}"}`);
  });

  it('leaves 13-digit integers that are nowhere near now alone', () => {
    expect(normalizeArgs({ t: 1111111111111 }, NOW)).toBe('{"t":1111111111111}');
  });

  it('masks long hex runs', () => {
    expect(normalizeArgs({ sha: 'deadbeefdeadbeefdeadbeef' }, NOW)).toBe(`{"sha":"${MASKS.hex}"}`);
    expect(normalizeArgs({ sha: 'deadbeef' }, NOW)).toBe('{"sha":"deadbeef"}');
  });

  it('masks JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g';
    expect(normalizeArgs({ auth: jwt }, NOW)).toBe(`{"auth":"${MASKS.jwt}"}`);
  });

  it('masks values embedded inside a longer string', () => {
    expect(maskString('see run 3f2504e0-4f89-41d3-9a0c-0305e82c3301 now', NOW)).toBe(
      `see run ${MASKS.uuid} now`,
    );
  });

  it('masks plumbing keys by name, whatever the value looks like', () => {
    const out = normalizeArgs(
      { requestId: 'abc', trace_id: 'x', 'Span-Id': 'y', nonce: 1, etag: { deep: true } },
      NOW,
    );
    expect(out).toBe(
      `{"Span-Id":"${MASKS.masked}","etag":"${MASKS.masked}","nonce":"${MASKS.masked}","requestId":"${MASKS.masked}","trace_id":"${MASKS.masked}"}`,
    );
  });

  it('collapses the middle of an over-long string but keeps its length', () => {
    const long = 'x'.repeat(1000);
    const out = truncateValue(long);
    expect(out).toContain('«len=1000»');
    expect(out.length).toBeLessThan(256);
    expect(truncateValue(`${'x'.repeat(999)}y`)).not.toBe(out);
  });
});

describe('pagination is progress, not a loop', () => {
  // The single most dangerous false positive AgentFuse could produce: masking a
  // pagination cursor would give every page of a listing the same fingerprint,
  // and the exact-repeat rule would halt an agent that is working correctly.
  it('never masks a cursor, so paging through results keeps distinct fingerprints', () => {
    const pages = ['a1b2c3d4e5f60718', '2026-09-15T14:03:22.114Z', 'deadbeefdeadbeefdead'].map(
      (cursor) => normalizeArgs({ path: '/docs', cursor }, NOW),
    );

    expect(new Set(pages).size).toBe(3);
    for (const page of pages) expect(page).not.toContain('«');
  });

  it('masks the same values under any other key', () => {
    expect(normalizeArgs({ token: 'a1b2c3d4e5f60718' }, NOW)).toBe(`{"token":"${MASKS.hex}"}`);
  });

  it('keeps the exemption inside arrays', () => {
    expect(normalizeArgs({ cursor: ['a1b2c3d4e5f60718'] }, NOW)).toBe(
      '{"cursor":["a1b2c3d4e5f60718"]}',
    );
  });
});

describe('normalizeArgs — properties', () => {
  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const once = normalizeArgs(value, NOW);
        expect(renormalize(once)).toBe(once);
      }),
      { numRuns: 300 },
    );
  });

  it('is invariant under key order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record: Record<string, unknown>) => {
        const shuffled = Object.fromEntries(Object.entries(record).reverse());
        expect(normalizeArgs(shuffled, NOW)).toBe(normalizeArgs(record, NOW));
      }),
      { numRuns: 300 },
    );
  });

  it('is stable across changes confined to a masked field', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), fc.jsonValue(), (rest, left, right) => {
        const a = normalizeArgs({ payload: rest, request_id: left }, NOW);
        const b = normalizeArgs({ payload: rest, request_id: right }, NOW);
        expect(a).toBe(b);
      }),
      { numRuns: 300 },
    );
  });
});

describe('argsPreview', () => {
  it('shows raw values, because a human approving a call needs to see them', () => {
    expect(argsPreview({ token: 'a1b2c3d4e5f60718' })).toBe('{"token":"a1b2c3d4e5f60718"}');
  });

  it('truncates to the requested width', () => {
    expect(argsPreview({ a: 'x'.repeat(100) }, 20)).toHaveLength(20);
  });
});
