import type { Clock } from '../ports/index.js';

/** Wall clock. The single place in the package where `Date.now()` is allowed. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * Hand-cranked clock for tests and snapshots.
 *
 * Every time-dependent assertion in the suite runs on one of these, which is
 * why cooldown expiry and trip report timestamps are testable without sleeping.
 */
export class FakeClock implements Clock {
  #now: number;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  /** Moves time forward and returns the new value. */
  advance(ms: number): number {
    this.#now += ms;
    return this.#now;
  }

  /** Jumps to an absolute instant. */
  set(ms: number): void {
    this.#now = ms;
  }
}
