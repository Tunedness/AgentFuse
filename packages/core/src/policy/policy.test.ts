import { describe, expect, it } from 'vitest';
import {
  compilePolicy,
  defaultPolicy,
  loadPolicy,
  mergeLoopDetection,
  PolicyValidationError,
  parsePolicy,
} from './compile.js';
import { formatDuration, parseDuration } from './duration.js';
import { evaluateRules } from './evaluate.js';
import { compileGlob, globMatches, toolKey } from './glob.js';

describe('parsePolicy — defaults', () => {
  const policy = defaultPolicy();

  it('turns an empty document into a complete, usable configuration', () => {
    expect(policy.version).toBe(1);
    expect(policy.session.key).toBe('auto');
    expect(policy.budgets.max_calls).toBe(200);
    expect(policy.loop_detection.exact_repeat.count).toBe(3);
    expect(policy.loop_detection.semantic.model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(policy.tools).toEqual([{ match: '*', action: 'allow', idempotent: false }]);
    expect(policy.report.recent_calls).toBe(20);
  });

  it('defaults to warn mode — the product safety posture, not a preference', () => {
    expect(policy.mode).toBe('warn');
  });

  it('defaults telemetry to off, per umbrella ADR-003', () => {
    expect(policy.telemetry.enabled).toBe(false);
  });

  it('defaults to distrusting server-supplied annotations', () => {
    expect(policy.annotations.trust_hints).toBe(false);
  });

  it('parses human durations into milliseconds', () => {
    expect(policy.session.idle_timeout).toBe(600_000);
    expect(policy.budgets.max_duration).toBe(1_800_000);
    expect(policy.approvals.timeout).toBe(120_000);
    expect(policy.loop_detection.cooldown.duration).toBe(120_000);
  });
});

describe('parsePolicy — validation', () => {
  it('requires a version', () => {
    expect(() => parsePolicy({})).toThrow(PolicyValidationError);
  });

  it('names the offending path', () => {
    try {
      parsePolicy({ version: 1, budgets: { max_duration: 'soon' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyValidationError);
      expect((error as PolicyValidationError).issues[0]).toContain('budgets.max_duration');
      expect((error as PolicyValidationError).message).toContain('30m');
    }
  });

  it('names an array index', () => {
    try {
      parsePolicy({ version: 1, tools: [{ match: '*', action: 'allow' }, { match: 5 }] });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as PolicyValidationError).issues.join('\n')).toContain('tools[1]');
    }
  });

  it('rejects a misspelled key instead of silently ignoring it', () => {
    expect(() => parsePolicy({ version: 1, budgets: { max_call: 10 } })).toThrow(
      PolicyValidationError,
    );
  });

  it('accepts a duration given as a plain number of milliseconds', () => {
    expect(parsePolicy({ version: 1, approvals: { timeout: 5 } }).approvals.timeout).toBe(5);
  });

  it('accepts a baggage session key but not an arbitrary one', () => {
    expect(parsePolicy({ version: 1, session: { key: 'baggage:run_id' } }).session.key).toBe(
      'baggage:run_id',
    );
    expect(() => parsePolicy({ version: 1, session: { key: 'whatever' } })).toThrow();
  });
});

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['120s', 120_000],
    ['2m', 120_000],
    ['1h', 3_600_000],
    ['7d', 604_800_000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it('rejects nonsense', () => {
    expect(() => parseDuration('soon')).toThrow(RangeError);
    expect(() => parseDuration('30')).toThrow(RangeError);
    expect(() => parseDuration(-1)).toThrow(RangeError);
    expect(() => parseDuration(1.5)).toThrow(RangeError);
  });

  it('round-trips through formatDuration', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(1_800_000)).toBe('30m');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(86_400_000)).toBe('1d');
    expect(formatDuration(1_500)).toBe('1500ms');
    expect(formatDuration(5_000)).toBe('5s');
  });
});

describe('glob matching', () => {
  it.each([
    ['*', 'fs__read', true],
    ['shell__*', 'shell__exec', true],
    ['shell__*', 'my_shell__exec', false],
    ['*__delete_*', 'db__delete_row', true],
    ['*__delete_*', 'db__select_row', false],
    ['fs__read?', 'fs__reads', true],
    ['fs__read?', 'fs__read', false],
    ['a.b', 'axb', false],
    ['a+b', 'a+b', true],
    ['a(b)', 'a(b)', true],
  ])('%s vs %s', (pattern, subject, expected) => {
    expect(globMatches(pattern, subject)).toBe(expected);
  });

  it('anchors both ends', () => {
    expect(compileGlob('read').test('read_file')).toBe(false);
  });

  it('builds the key rules are matched against', () => {
    expect(toolKey('fs', 'read_file')).toBe('fs__read_file');
  });
});

describe('evaluateRules', () => {
  const policy = loadPolicy({
    version: 1,
    tools: [
      { match: '*__delete_*', action: 'require_approval', note: 'destructive' },
      { match: 'shell__*', action: 'deny' },
      { match: 'fs__list', action: 'allow', idempotent: true, loop_detection: { window: 40 } },
      { match: '*', action: 'allow' },
    ],
  });

  it('takes the first match', () => {
    expect(evaluateRules(policy, 'db', 'delete_row').matchedRule).toBe('tools[0]');
    expect(evaluateRules(policy, 'shell', 'exec').action).toBe('deny');
    expect(evaluateRules(policy, 'fs', 'read').matchedRule).toBe('tools[3]');
  });

  it('carries the rule note and the idempotent flag', () => {
    expect(evaluateRules(policy, 'db', 'delete_row').note).toBe('destructive');
    expect(evaluateRules(policy, 'fs', 'list').idempotent).toBe(true);
  });

  it('merges a per-rule loop override over the global settings', () => {
    const evaluation = evaluateRules(policy, 'fs', 'list');
    expect(evaluation.loop.window).toBe(40);
    expect(evaluation.loop.exact_repeat.count).toBe(3);
  });

  it('allows an unmatched tool', () => {
    const bare = loadPolicy({ version: 1, tools: [{ match: 'shell__*', action: 'deny' }] });
    const evaluation = evaluateRules(bare, 'fs', 'read');
    expect(evaluation.action).toBe('allow');
    expect(evaluation.matchedRule).toBeUndefined();
    expect(evaluation.idempotent).toBe(false);
  });

  it('caches the match so the hot path never rebuilds a regex', () => {
    const first = policy.match('db', 'delete_row');
    expect(policy.match('db', 'delete_row')).toBe(first);
  });
});

describe('compilePolicy', () => {
  it('hashes the resolved policy', () => {
    const a = compilePolicy(parsePolicy({ version: 1 }));
    const b = compilePolicy(parsePolicy({ version: 1, mode: 'warn' }));
    const c = compilePolicy(parsePolicy({ version: 1, mode: 'enforce' }));
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).not.toBe(c.sha256);
    expect(a.sha256).toHaveLength(64);
  });

  it('sizes the window for the widest rule, the longest cycle and the report', () => {
    const wide = compilePolicy(
      parsePolicy({
        version: 1,
        loop_detection: { window: 4, cycle: { max_period: 9 } },
        report: { recent_calls: 5 },
        tools: [{ match: '*', action: 'allow', loop_detection: { window: 12 } }],
      }),
    );
    expect(wide.windowCapacity).toBe(18);
  });
});

describe('mergeLoopDetection', () => {
  const base = defaultPolicy().loop_detection;

  it('returns the base untouched when there is no override', () => {
    expect(mergeLoopDetection(base, undefined)).toBe(base);
  });

  it('applies every branch of the override', () => {
    const merged = mergeLoopDetection(base, {
      window: 2,
      min_calls: 3,
      exact_repeat: { count: 9 },
      error_repeat: { count: 8 },
      cycle: { max_period: 7 },
      semantic: { enabled: false, provider: 'none', model: 'm', threshold: 0.1 },
      on_trip: 'warn',
      cooldown: { calls: 6, duration: 1_000 },
    });
    expect(merged).toEqual({
      window: 2,
      min_calls: 3,
      exact_repeat: { count: 9 },
      error_repeat: { count: 8 },
      cycle: { max_period: 7 },
      semantic: {
        enabled: false,
        provider: 'none',
        model: 'm',
        threshold: 0.1,
        consecutive_windows: base.semantic.consecutive_windows,
      },
      on_trip: 'warn',
      cooldown: { calls: 6, duration: 1_000 },
    });
  });

  it('keeps the base values an override leaves out', () => {
    expect(mergeLoopDetection(base, { on_trip: 'warn' })).toEqual({ ...base, on_trip: 'warn' });
  });
});
