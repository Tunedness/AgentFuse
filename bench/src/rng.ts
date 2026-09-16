/**
 * A seeded pseudo-random generator, because a benchmark corpus that changes
 * between runs measures nothing.
 *
 * `Math.random()` is banned here for the same reason `packages/core` bans it:
 * a number nobody can reproduce is a number nobody can argue with. Phase 3's
 * window tests already established the precedent (a seeded LCG rather than
 * `Math.random()`), and the detection corpus needs the stronger version of the
 * property — the generated JSONL has to come out **byte-identical** on any
 * machine, so the committed numbers can be checked rather than believed.
 *
 * mulberry32: 32-bit state, one multiply-xorshift round, period 2³². Small
 * enough to read in one sitting, good enough that no scenario's variation
 * correlates with another's.
 */

/** Hashes a string into a 32-bit seed (FNV-1a). */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A deterministic source of variation. */
export class Rng {
  #state: number;

  constructor(seed: number | string) {
    this.#state = (typeof seed === 'string' ? seedFrom(seed) : seed >>> 0) || 0x9e3779b9;
  }

  /** The next float in `[0, 1)`. */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in `[min, max]`, both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** One element. Throws on an empty list rather than returning `undefined`. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() from an empty list');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** `count` distinct elements, in a shuffled order. */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, count);
  }

  /** A shuffled copy (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  }

  /** `true` with probability `p`. */
  bool(p: number): boolean {
    return this.next() < p;
  }

  /** A lowercase hex string of `length` characters. */
  hex(length: number): string {
    let out = '';
    while (out.length < length) out += this.int(0, 15).toString(16);
    return out.slice(0, length);
  }

  /** A base64url-ish opaque token: deliberately *not* pure hex. */
  token(length: number): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let out = '';
    while (out.length < length) out += alphabet[this.int(0, alphabet.length - 1)];
    return out;
  }
}
