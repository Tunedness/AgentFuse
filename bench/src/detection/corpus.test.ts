import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { errorSignature, fingerprint, normalizeArgs } from '@agentfuse/core';
import { describe, expect, it } from 'vitest';
import {
  ALL_SCENARIOS,
  DEFAULT_SEED,
  fromJsonl,
  generateCorpus,
  SESSIONS_PER_SCENARIO,
  toJsonl,
} from './corpus.js';
import { NEGATIVE_SCENARIOS, POSITIVE_SCENARIOS } from './types.js';

/**
 * The corpus is the measurement instrument, so these tests are about the
 * instrument rather than about AgentFuse.
 *
 * The one that matters most is determinism: the committed JSONL, the committed
 * results and the CI gate all assume that regenerating the corpus produces the
 * same bytes. If that ever stops being true the numbers in
 * `docs/implementation-status.md` become unfalsifiable.
 */

const CORPUS_PATH = fileURLToPath(new URL('../../detection/corpus.jsonl', import.meta.url));

/** A fixed clock, so the epoch mask in `normalizeArgs` cannot wobble. */
const NOW = 1_770_000_000_000;

describe('the corpus generator', () => {
  it('regenerates byte-identically from the same seed', () => {
    const a = toJsonl(generateCorpus());
    const b = toJsonl(generateCorpus());

    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(50_000);
  });

  it('produces a different corpus from a different seed', () => {
    // Otherwise the seed is decoration and the "seeded" claim is empty.
    expect(toJsonl(generateCorpus({ seed: 'other' }))).not.toBe(toJsonl(generateCorpus()));
  });

  it('survives a JSONL round trip unchanged', () => {
    const sessions = generateCorpus();

    expect(fromJsonl(toJsonl(sessions))).toEqual(sessions);
  });

  it('matches the committed corpus file', () => {
    // The committed file is what the runner reads and what CI gates on. If this
    // fails, either the generator changed (regenerate, and re-run the sweep —
    // the thresholds were calibrated against those exact bytes) or the file was
    // edited by hand, which it must never be.
    const committed = readFileSync(CORPUS_PATH, 'utf8');
    const generated = toJsonl(generateCorpus());

    expect(createHash('sha256').update(generated).digest('hex')).toBe(
      createHash('sha256').update(committed).digest('hex'),
    );
  });

  it('holds twenty sessions of each of the ten scenarios', () => {
    const sessions = generateCorpus();
    expect(sessions).toHaveLength(ALL_SCENARIOS.length * SESSIONS_PER_SCENARIO);

    for (const scenario of ALL_SCENARIOS) {
      expect(
        sessions.filter((s) => s.scenario === scenario),
        scenario,
      ).toHaveLength(SESSIONS_PER_SCENARIO);
    }
    expect(DEFAULT_SEED).toBe('agentfuse-phase-9');
  });

  it('labels every session, and labels it consistently with its scenario', () => {
    for (const session of generateCorpus()) {
      const expected = (POSITIVE_SCENARIOS as readonly string[]).includes(session.scenario)
        ? 'positive'
        : 'negative';
      expect(session.label, session.id).toBe(expected);
      expect((NEGATIVE_SCENARIOS as readonly string[]).includes(session.scenario)).toBe(
        expected === 'negative',
      );
    }
  });

  it('gives every positive a loop start and every negative none', () => {
    for (const session of generateCorpus()) {
      if (session.label === 'positive') {
        expect(session.loopStartIndex, session.id).not.toBeNull();
        expect(session.loopStartIndex as number).toBeLessThan(session.calls.length);
      } else {
        expect(session.loopStartIndex, session.id).toBeNull();
      }
    }
  });

  it('gives every session enough calls for a window to form', () => {
    // A session shorter than the default window could never be scored, and a
    // corpus of them would report a flattering false-positive rate for the
    // uninteresting reason that nothing was ever compared.
    for (const session of generateCorpus()) {
      expect(session.calls.length, session.id).toBeGreaterThanOrEqual(5);
      for (const call of session.calls) {
        expect(call.serverName, session.id).not.toBe('');
        expect(call.toolName, session.id).not.toBe('');
        expect(call.result, session.id).not.toBe('');
      }
    }
  });
});

/**
 * The two scenarios the whole calibration rests on: if a deterministic rule can
 * see them, the semantic layer is never the thing being measured.
 */
describe('the semantic-only positives', () => {
  const print = (call: { serverName: string; toolName: string; args: Record<string, unknown> }) =>
    fingerprint(call.serverName, call.toolName, normalizeArgs(call.args, NOW));

  it('never repeat a fingerprint, never fail, and never oscillate', () => {
    const sessions = generateCorpus().filter(
      (s) => s.scenario === 'reworded-retry' || s.scenario === 'drifting-loop',
    );
    expect(sessions).toHaveLength(2 * SESSIONS_PER_SCENARIO);

    for (const session of sessions) {
      const loopCalls = session.calls.slice(session.loopStartIndex as number);
      const prints = loopCalls.map(print);

      // R1 is blind: every fingerprint in the loop is unique.
      expect(new Set(prints).size, `${session.id} distinct fingerprints`).toBe(prints.length);
      // R2 is blind: nothing fails.
      expect(
        loopCalls.some((c) => c.isError),
        `${session.id} has no errors`,
      ).toBe(false);
      // R3 is blind: no period 2..4 repeats, which follows from uniqueness but
      // is asserted directly so a future edit cannot quietly break it.
      for (let period = 2; period <= 4; period += 1) {
        for (let i = 0; i + period < prints.length; i += 1) {
          expect(prints[i], `${session.id} period ${period}`).not.toBe(prints[i + period]);
        }
      }
    }
  });
});

describe('the false-positive traps', () => {
  it('give pagination a cursor that actually moves', () => {
    for (const session of generateCorpus().filter((s) => s.scenario === 'pagination-sweep')) {
      const prints = new Set(
        session.calls.map((c) => fingerprint(c.serverName, c.toolName, normalizeArgs(c.args, NOW))),
      );
      // If this collapses, the sweep stopped being a trap and became a loop:
      // the exact-repeat rule would catch it for the wrong reason.
      expect(prints.size, session.id).toBe(session.calls.length);
    }
  });

  it('give the converging build-test loop an unchanging command', () => {
    // The trap is precisely that the arguments do not move; only the result
    // does. Weakening this would delete the scenario's whole point.
    for (const session of generateCorpus().filter((s) => s.scenario === 'converging-build-test')) {
      const runs = session.calls.filter((c) => c.toolName === 'run_command');
      expect(runs.length, session.id).toBeGreaterThanOrEqual(4);
      expect(new Set(runs.map((c) => JSON.stringify(c.args))).size, session.id).toBe(1);
      // And the answers must differ, or there would be no progress to protect.
      expect(new Set(runs.map((c) => c.result)).size, session.id).toBe(runs.length);
    }
  });

  it('keep the error loop on one signature and the converging loop off it', () => {
    const signature = (call: { result: string; errorCode?: string }) =>
      errorSignature({
        text: call.result,
        ...(call.errorCode !== undefined ? { code: call.errorCode } : undefined),
      });

    for (const session of generateCorpus().filter((s) => s.scenario === 'error-loop')) {
      const signatures = new Set(session.calls.filter((c) => c.isError).map(signature));
      expect(signatures.size, session.id).toBe(1);
    }
    for (const session of generateCorpus().filter((s) => s.scenario === 'converging-build-test')) {
      const failures = session.calls.filter((c) => c.isError);
      // Each round reports a different set of failing tests, so R2 has nothing
      // to hold on to — as it should not, because the agent is converging.
      expect(new Set(failures.map(signature)).size, session.id).toBe(failures.length);
    }
  });
});
