import { describe, expect, it } from 'vitest';
import { noveltyTokens, ResultNoveltyWindow } from './novelty.js';

/**
 * The novelty window is the answer half of the semantic rule, and phase 9's
 * measurement is what put it there: on embedding similarity alone, a pagination
 * sweep scores higher than a real loop. These tests pin the property that makes
 * the difference — the same answer twice is stale, ten different answers are
 * not — plus the eviction bookkeeping that would otherwise rot silently,
 * because a stale document-frequency map produces a plausible number rather
 * than a crash.
 */

function fill(window: ResultNoveltyWindow, texts: readonly string[]): ResultNoveltyWindow {
  for (const text of texts) window.push(text);
  return window;
}

describe('noveltyTokens', () => {
  it('keeps lowercased alphanumeric runs and nothing else', () => {
    expect([...noveltyTokens('Wrote 1432 bytes to src/auth/session.ts.')]).toEqual([
      'wrote',
      '1432',
      'bytes',
      'to',
      'src',
      'auth',
      'session',
      'ts',
    ]);
  });

  it('deduplicates', () => {
    expect(noveltyTokens('no no no issues issues').size).toBe(2);
  });

  it('caps how many tokens one answer can contribute', () => {
    // A 512-character summary cannot reach this, but `resultSummary` is
    // upstream-supplied and the window holds one of these per session per slot.
    const text = Array.from({ length: 1000 }, (_, i) => `t${i}`).join(' ');
    expect(noveltyTokens(text).size).toBe(256);
  });

  it('finds nothing in punctuation', () => {
    expect(noveltyTokens('!!! --- ...').size).toBe(0);
  });
});

describe('ResultNoveltyWindow', () => {
  it('refuses a capacity that is not a positive integer', () => {
    expect(() => new ResultNoveltyWindow({ capacity: 0 })).toThrow(RangeError);
    expect(() => new ResultNoveltyWindow({ capacity: 2.5 })).toThrow(RangeError);
  });

  it('answers null until there are two answers to compare', () => {
    const window = new ResultNoveltyWindow({ capacity: 4 });
    expect(window.staleness()).toBeNull();
    window.push('one');
    expect(window.staleness()).toBeNull();
    window.push('one');
    expect(window.staleness()).toBe(1);
  });

  it('answers null below minCalls', () => {
    const window = fill(new ResultNoveltyWindow({ capacity: 8, minCalls: 5 }), [
      'a',
      'a',
      'a',
      'a',
    ]);
    expect(window.staleness()).toBeNull();
    window.push('a');
    expect(window.staleness()).toBe(1);
    // The per-call override wins, because `loop_detection.min_calls` is
    // overridable per rule and the window outlives any one rule match.
    expect(fill(new ResultNoveltyWindow({ capacity: 8 }), ['a', 'a']).staleness(5)).toBeNull();
  });

  it('scores identical answers as completely stale', () => {
    const window = fill(new ResultNoveltyWindow({ capacity: 4 }), [
      'EACCES: permission denied',
      'EACCES: permission denied',
      'EACCES: permission denied',
    ]);
    expect(window.staleness()).toBe(1);
  });

  it('scores wholly disjoint answers as completely fresh', () => {
    const window = fill(new ResultNoveltyWindow({ capacity: 4 }), ['alpha', 'beta', 'gamma']);
    expect(window.staleness()).toBe(0);
  });

  it('separates a pagination sweep from a retry loop', () => {
    // The whole reason this class exists. Both windows repeat one tool with
    // near-identical requests; only the answers tell them apart.
    const pagination = fill(new ResultNoveltyWindow({ capacity: 5 }), [
      'Page 1: 20 issues. #412 Fix flaky retry; #413 Router drops slash',
      'Page 2: 20 issues. #418 Pool exhausts; #421 Worker leaks socket',
      'Page 3: 20 issues. #430 Token refresh races; #433 Migrate dry run',
      'Page 4: 20 issues. #447 Cookie SameSite; #450 Backoff not jittered',
      'Page 5: 20 issues. #461 Logger stdout; #466 Config XDG',
    ]);
    const retry = fill(new ResultNoveltyWindow({ capacity: 5 }), [
      'No issues matched the query.',
      'No issues matched the query.',
      'No issues matched the query.',
      'No issues matched the query.',
      'No issues matched the query.',
    ]);

    expect(retry.staleness()).toBe(1);
    // Shared boilerplate ("page", "issues", the numbers 1..5 and 20) keeps this
    // above zero; what matters is the gap, and it is wide.
    expect(pagination.staleness()).toBeLessThan(0.7);
    expect((retry.staleness() as number) - (pagination.staleness() as number)).toBeGreaterThan(0.3);
  });

  it('treats an empty answer as fully stale', () => {
    // A tool that returns nothing, over and over, is telling the agent nothing
    // over and over. Scoring the empty string as novel would make the
    // silent-tool loop the one case this layer could not see.
    const window = fill(new ResultNoveltyWindow({ capacity: 3 }), ['', '', '']);
    expect(window.staleness()).toBe(1);
  });

  it('forgets tokens that have been evicted', () => {
    const window = new ResultNoveltyWindow({ capacity: 3 });
    fill(window, ['alpha beta', 'alpha beta', 'alpha beta']);
    expect(window.staleness()).toBe(1);

    // Push three disjoint answers: nothing from the stale prefix may survive in
    // the document-frequency map, or the window would keep reporting staleness
    // it no longer has any evidence for.
    fill(window, ['gamma', 'delta', 'epsilon']);
    expect(window.size).toBe(3);
    expect(window.staleness()).toBe(0);
  });

  it('holds only its capacity', () => {
    const window = fill(new ResultNoveltyWindow({ capacity: 2 }), ['a', 'b', 'c', 'd']);
    expect(window.size).toBe(2);
    expect(window.capacity).toBe(2);
    expect(window.staleness()).toBe(0);
  });

  it('keeps the newest answers when the capacity shrinks', () => {
    const window = fill(new ResultNoveltyWindow({ capacity: 5 }), [
      'old one',
      'old two',
      'same',
      'same',
      'same',
    ]);
    window.ensureCapacity(3);

    expect(window.size).toBe(3);
    expect(window.staleness()).toBe(1);
  });

  it('keeps everything when the capacity grows', () => {
    const window = fill(new ResultNoveltyWindow({ capacity: 2 }), ['same', 'same']);
    window.ensureCapacity(6);

    expect(window.size).toBe(2);
    expect(window.staleness()).toBe(1);
    window.push('novel token here');
    expect(window.staleness()).toBeLessThan(1);
  });

  it('is a no-op when the capacity does not change, and refuses a bad one', () => {
    const window = fill(new ResultNoveltyWindow({ capacity: 3 }), ['a', 'a']);
    window.ensureCapacity(3);
    expect(window.size).toBe(2);
    expect(() => window.ensureCapacity(0)).toThrow(RangeError);
  });

  it('empties on clear', () => {
    const window = fill(new ResultNoveltyWindow({ capacity: 3 }), ['a', 'a', 'a']);
    window.clear();

    expect(window.size).toBe(0);
    expect(window.staleness()).toBeNull();
    // And the frequency map went with it: two fresh disjoint answers must score
    // zero, not inherit the cleared history.
    fill(window, ['x', 'y']);
    expect(window.staleness()).toBe(0);
  });

  it('matches a from-scratch computation after heavy churn', () => {
    // The incremental document-frequency map is the one thing here that can
    // drift without ever throwing, so it is checked against the naive answer.
    const capacity = 7;
    const window = new ResultNoveltyWindow({ capacity });
    const answers: string[] = [];
    // A seeded, closed-form sequence: no Math.random, and the mixture of
    // repeats and novelties is what exercises the eviction path.
    for (let i = 0; i < 500; i += 1) {
      answers.push(`shared token ${i % 5} unique${i} extra${(i * 7) % 11}`);
      window.push(answers[answers.length - 1] as string);
    }

    const tail = answers.slice(-capacity).map(noveltyTokens);
    const frequency = new Map<string, number>();
    for (const set of tail)
      for (const token of set) {
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
      }
    let total = 0;
    for (const set of tail) {
      let shared = 0;
      for (const token of set) if ((frequency.get(token) ?? 0) >= 2) shared += 1;
      total += shared / set.size;
    }

    expect(window.staleness()).toBeCloseTo(total / tail.length, 12);
  });
});
