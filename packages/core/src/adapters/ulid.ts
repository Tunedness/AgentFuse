import type { Clock, IdGenerator } from '../ports/index.js';

/**
 * Crockford base32 — no I, L, O or U, so an id read aloud or copied off a
 * terminal cannot be misheard.
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_BYTES = 10;
const RANDOM_CHARS = 16;
/** 2^48 - 1 ms, i.e. the year 10889. */
const MAX_TIME = 281474976710655;

/** Fills a buffer with random bytes. Injected so tests can make ids reproducible. */
export type RandomSource = (buffer: Uint8Array<ArrayBuffer>) => void;

const defaultRandom: RandomSource = (buffer) => {
  globalThis.crypto.getRandomValues(buffer);
};

/** `charAt` rather than indexing, so `noUncheckedIndexedAccess` stays happy. */
function chr(index: number): string {
  return ENCODING.charAt(index);
}

function encodeTime(now: number): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`ULID timestamp out of range: ${now}`);
  }
  let rest = now;
  let out = '';
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out = chr(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/**
 * Encodes 10 bytes (80 bits) as 16 base32 characters, five bits at a time,
 * most-significant bit first.
 */
function encodeRandom(bytes: Uint8Array<ArrayBuffer>): string {
  let out = '';
  let bitBuffer = 0;
  let bitCount = 0;
  let produced = 0;
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && produced < RANDOM_CHARS) {
      bitCount -= 5;
      out += chr((bitBuffer >>> bitCount) & 31);
      produced += 1;
    }
    bitBuffer &= (1 << bitCount) - 1;
  }
  return out;
}

/** Adds one to a big-endian byte counter, in place. Returns false on overflow. */
function increment(bytes: Uint8Array<ArrayBuffer>): boolean {
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    const next = (bytes[i] ?? 0) + 1;
    if (next <= 0xff) {
      bytes[i] = next;
      return true;
    }
    bytes[i] = 0;
  }
  return false;
}

/**
 * Monotonic ULID generator.
 *
 * Written by hand rather than pulled in as a dependency: `@agentfuse/core` has
 * exactly one runtime dependency (zod) and that is a property worth ~40 lines.
 *
 * Within a single millisecond the random component is incremented rather than
 * redrawn, so ids minted back-to-back sort in creation order — which is what
 * makes a trip report's call list readable.
 */
export class UlidGenerator implements IdGenerator {
  readonly #clock: Clock;
  readonly #random: RandomSource;
  #lastTime = -1;
  #lastRandom: Uint8Array<ArrayBuffer> = new Uint8Array(RANDOM_BYTES);

  constructor(clock: Clock, random: RandomSource = defaultRandom) {
    this.#clock = clock;
    this.#random = random;
  }

  next(): string {
    const now = this.#clock.now();
    if (now === this.#lastTime) {
      if (!increment(this.#lastRandom)) {
        // 2^80 ids in one millisecond is not a real scenario, but silently
        // wrapping would break monotonicity, so redraw and move on.
        this.#random(this.#lastRandom);
      }
    } else {
      this.#lastTime = now;
      this.#lastRandom = new Uint8Array(RANDOM_BYTES);
      this.#random(this.#lastRandom);
    }
    return encodeTime(now) + encodeRandom(this.#lastRandom);
  }
}

/**
 * Deterministic id generator for tests and snapshots: `01TEST0000000000000001`,
 * `…02`, and so on.
 */
export class CounterIdGenerator implements IdGenerator {
  #n = 0;
  readonly #prefix: string;

  constructor(prefix = '01TEST') {
    this.#prefix = prefix;
  }

  next(): string {
    this.#n += 1;
    const width = TIME_CHARS + RANDOM_CHARS - this.#prefix.length;
    return this.#prefix + String(this.#n).padStart(width, '0');
  }
}
