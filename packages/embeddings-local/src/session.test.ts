import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vitest';
import { defaultThreads } from './session.js';

describe('defaultThreads', () => {
  it('caps the runtime at four threads', () => {
    // Embedding is background work behind a queue. It is allowed to be slower
    // than it could be; it is not allowed to take a 64-core machine away from
    // whatever that machine is actually for.
    expect(defaultThreads()).toBeLessThanOrEqual(4);
  });

  it('never asks for more threads than the machine has', () => {
    expect(defaultThreads()).toBeLessThanOrEqual(availableParallelism());
    expect(defaultThreads()).toBeGreaterThanOrEqual(1);
  });
});
