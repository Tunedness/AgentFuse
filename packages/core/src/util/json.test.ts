import { describe, expect, it } from 'vitest';
import { sha256 } from './hash.js';
import { stableStringify, toJsonValue } from './json.js';

describe('toJsonValue', () => {
  it('passes primitives through', () => {
    expect(toJsonValue('a')).toBe('a');
    expect(toJsonValue(true)).toBe(true);
    expect(toJsonValue(1)).toBe(1);
    expect(toJsonValue(null)).toBe(null);
  });

  it('collapses non-finite numbers, undefined, functions and symbols', () => {
    expect(toJsonValue(Number.NaN)).toBe(null);
    expect(toJsonValue(undefined)).toBe(null);
    expect(toJsonValue(() => 1)).toBe(null);
    expect(toJsonValue(Symbol('x'))).toBe(null);
  });

  it('renders bigint as its decimal string', () => {
    expect(toJsonValue(10n)).toBe('10');
  });

  it('drops undefined and function properties, like JSON.stringify', () => {
    expect(toJsonValue({ a: 1, b: undefined, c: () => 1 })).toEqual({ a: 1 });
  });

  it('honours toJSON', () => {
    expect(toJsonValue(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
  });

  it('breaks cycles instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(toJsonValue(cyclic)).toEqual({ a: 1, self: null });
  });

  it('keeps a __proto__ key as an own property', () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as unknown;
    expect(stableStringify(toJsonValue(parsed))).toBe('{"__proto__":{"polluted":true},"a":1}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('stableStringify', () => {
  it('sorts keys and preserves array order', () => {
    expect(stableStringify({ b: [2, 1], a: 1 })).toBe('{"a":1,"b":[2,1]}');
  });

  it('skips undefined entries', () => {
    const record = { a: 1, b: undefined } as unknown as Record<string, never>;
    expect(stableStringify(record)).toBe('{"a":1}');
  });

  it('escapes strings the way JSON does', () => {
    expect(stableStringify('a"b\n')).toBe('"a\\"b\\n"');
  });
});

describe('sha256', () => {
  it('matches the known digest of the empty string', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
