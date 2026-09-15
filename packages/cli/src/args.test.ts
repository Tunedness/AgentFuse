import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';
import { CliError } from './errors.js';

const SPEC = {
  booleans: ['quiet', 'help'],
  values: ['policy', 'mode'],
  aliases: { '-q': '--quiet', '-p': '--policy', '-h': '--help' },
} as const;

describe('parseArgs', () => {
  it('collects positionals in order', () => {
    const args = parseArgs(['list', 'extra'], SPEC);

    expect(args.positionals).toEqual(['list', 'extra']);
    expect(args.rest).toEqual([]);
    expect(args.sawSeparator).toBe(false);
  });

  it('reads boolean flags and their aliases', () => {
    expect(parseArgs(['--quiet'], SPEC).bool('quiet')).toBe(true);
    expect(parseArgs(['-q'], SPEC).bool('quiet')).toBe(true);
    expect(parseArgs([], SPEC).bool('quiet')).toBe(false);
  });

  it('reads value flags as a separate token or after an equals sign', () => {
    expect(parseArgs(['--policy', 'a.yaml'], SPEC).value('policy')).toBe('a.yaml');
    expect(parseArgs(['--policy=a.yaml'], SPEC).value('policy')).toBe('a.yaml');
    expect(parseArgs(['-p', 'a.yaml'], SPEC).value('policy')).toBe('a.yaml');
    expect(parseArgs([], SPEC).value('policy')).toBeUndefined();
  });

  it('does not treat the next flag as a value', () => {
    // The whole reason flags are declared rather than inferred: a parser that
    // guessed from "does the next token start with a dash" would read
    // `--policy --quiet` as policy="--quiet" for a boolean-looking value and
    // as a missing value for a real one, and get one of them wrong.
    const args = parseArgs(['--policy', '--quiet'], SPEC);

    expect(args.value('policy')).toBe('--quiet');
    expect(args.bool('quiet')).toBe(false);
  });

  it('takes a lone dash as a positional', () => {
    expect(parseArgs(['-'], SPEC).positionals).toEqual(['-']);
  });

  it('keeps an empty inline value rather than calling it missing', () => {
    expect(parseArgs(['--policy='], SPEC).value('policy')).toBe('');
  });

  it('lets the last spelling of a repeated flag win', () => {
    expect(parseArgs(['--mode', 'warn', '--mode', 'enforce'], SPEC).value('mode')).toBe('enforce');
  });

  describe('the `--` separator', () => {
    it('hands everything after it over verbatim', () => {
      const args = parseArgs(['--quiet', '--', 'node', 'server.mjs', '--verbose'], SPEC);

      expect(args.bool('quiet')).toBe(true);
      expect(args.rest).toEqual(['node', 'server.mjs', '--verbose']);
      expect(args.sawSeparator).toBe(true);
    });

    it('does not parse the child`s flags, even ones AgentFuse knows', () => {
      const args = parseArgs(['--', 'node', 'x.mjs', '--policy', 'theirs.yaml'], SPEC);

      expect(args.value('policy')).toBeUndefined();
      expect(args.rest).toEqual(['node', 'x.mjs', '--policy', 'theirs.yaml']);
    });

    it('keeps a second `--` as part of the child command line', () => {
      expect(parseArgs(['--', 'npx', '--', 'thing'], SPEC).rest).toEqual(['npx', '--', 'thing']);
    });

    it('records the separator even when nothing follows it', () => {
      const args = parseArgs(['--'], SPEC);

      // `rest: []` on its own cannot distinguish "no command given" from
      // "no separator given", and those two need different errors.
      expect(args.rest).toEqual([]);
      expect(args.sawSeparator).toBe(true);
    });
  });

  describe('rejections', () => {
    it('refuses an unknown flag and suggests the nearest known one', () => {
      let caught: unknown;
      try {
        parseArgs(['--quite'], SPEC);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(CliError);
      expect((caught as CliError).message).toBe('unknown flag --quite');
      expect((caught as CliError).hints[0]).toBe('Did you mean --quiet?');
    });

    it('prefers the nearest candidate over one that is merely within budget', () => {
      let caught: CliError | undefined;
      try {
        // One edit from `mode`, two from `help`.
        parseArgs(['--mole'], SPEC);
      } catch (error) {
        caught = error as CliError;
      }

      expect(caught?.hints[0]).toBe('Did you mean --mode?');
    });

    it('holds a short flag to a single edit', () => {
      let caught: CliError | undefined;
      try {
        // Two edits from `mode`, which is too loose a match for a four-letter
        // word: at that distance the words are simply different.
        parseArgs(['--mold'], { booleans: ['q'], values: ['mode'] });
      } catch (error) {
        caught = error as CliError;
      }

      expect(caught?.hints[0]).toBe('Did you mean --mode?');

      caught = undefined;
      try {
        parseArgs(['--qzz'], { booleans: ['q'], values: ['mode'] });
      } catch (error) {
        caught = error as CliError;
      }

      expect(caught?.hints.some((hint) => hint.startsWith('Did you mean'))).toBe(false);
    });

    it('suggests across a transposition, the commonest typo of all', () => {
      let caught: CliError | undefined;
      try {
        parseArgs(['--polciy'], SPEC);
      } catch (error) {
        caught = error as CliError;
      }

      expect(caught?.hints[0]).toBe('Did you mean --policy?');
    });

    it('does not suggest a flag that is merely the least wrong', () => {
      let caught: CliError | undefined;
      try {
        parseArgs(['--verbose'], SPEC);
      } catch (error) {
        caught = error as CliError;
      }

      expect(caught?.hints.some((hint) => hint.startsWith('Did you mean'))).toBe(false);
    });

    it('refuses a value on a boolean flag', () => {
      expect(() => parseArgs(['--quiet=yes'], SPEC)).toThrow(/takes no value/);
    });

    it('refuses a value flag with nothing after it', () => {
      expect(() => parseArgs(['--policy'], SPEC)).toThrow(/needs a value/);
    });

    it('does not let a value flag swallow the `--` separator', () => {
      expect(() => parseArgs(['--policy', '--', 'node', 'x.mjs'], SPEC)).toThrow(/needs a value/);
    });

    it('rejects any flag when the spec declares none', () => {
      expect(() => parseArgs(['--anything'])).toThrow(/unknown flag/);
    });
  });
});
