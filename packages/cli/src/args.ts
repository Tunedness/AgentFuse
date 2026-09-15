/**
 * Argument parsing, with no dependency and no cleverness.
 *
 * The only genuinely hard requirement is `--`: `agentfuse wrap -- node
 * server.mjs --verbose` has to give the child its own `--verbose` untouched,
 * and a parser that tried to be helpful about unknown flags would swallow it.
 * So the first bare `--` ends AgentFuse's arguments and everything after it is
 * the child's command line, verbatim.
 *
 * Flags are declared per command rather than guessed. `--quiet` takes no value
 * and `--policy` takes one, and a parser that inferred that from whether the
 * next token starts with a dash gets `--policy --quiet` wrong in a way that is
 * very hard to see. Declaring them also means an unknown flag is an error with
 * a suggestion instead of a silently ignored typo.
 */

import { CliError } from './errors.js';

/** Which flags a command accepts, and of what shape. */
export interface FlagSpec {
  /** Flags that take no value. Present means `true`. */
  readonly booleans?: readonly string[];
  /** Flags that take the next token, or the part after `=`. */
  readonly values?: readonly string[];
  /** Short or alternative spellings, mapped to the canonical name. */
  readonly aliases?: Readonly<Record<string, string>>;
}

/** The result of {@link parseArgs}. */
export interface ParsedArgs {
  /** Non-flag tokens before `--`, in order. The first is the sub-command. */
  readonly positionals: readonly string[];
  /** Everything after the first bare `--`, verbatim. */
  readonly rest: readonly string[];
  /** Whether a bare `--` appeared at all. Empty `rest` is otherwise ambiguous. */
  readonly sawSeparator: boolean;
  /** Whether a boolean flag was given. */
  bool(name: string): boolean;
  /** The value of a value flag, or `undefined`. */
  value(name: string): string | undefined;
}

/**
 * The closest known flag to a typo, if one is close enough to suggest.
 *
 * Two edits for anything longer than three characters, one for the short
 * flags; the nearest candidate wins, so a one-edit match is never beaten by a
 * two-edit one. Beyond that budget the words are simply different, and
 * suggesting `--quiet` for `--verbose` helps nobody.
 */
function nearest(name: string, known: readonly string[]): string | undefined {
  const budget = name.length <= 3 ? 1 : 2;
  for (let allowed = 1; allowed <= budget; allowed += 1) {
    const hit = known.find((candidate) => withinEdits(name, candidate, allowed));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Whether at most `budget` edits turn `a` into `b`.
 *
 * Damerau rather than plain Levenshtein: a transposition costs one edit,
 * because `--quite` for `--quiet` is the single most common way to mistype a
 * flag and Levenshtein scores it the same as two unrelated wrong letters.
 *
 * Bounded recursion over the suffixes rather than a dynamic-programming table.
 * The budget is one or two and the strings are flag names, so the search is a
 * handful of comparisons — and it reads with no index arithmetic, which under
 * `noUncheckedIndexedAccess` is the difference between this and five
 * unreachable `?? 0` guards.
 */
function withinEdits(a: string, b: string, budget: number): boolean {
  let i = 0;
  while (i < a.length && i < b.length && a.charAt(i) === b.charAt(i)) i += 1;
  if (i === a.length && i === b.length) return true;
  if (budget === 0) return false;

  const next = budget - 1;
  const transposed =
    a.length > i + 1 &&
    b.length > i + 1 &&
    a.charAt(i) === b.charAt(i + 1) &&
    a.charAt(i + 1) === b.charAt(i);

  return (
    // substitute, delete, insert, transpose
    withinEdits(a.slice(i + 1), b.slice(i + 1), next) ||
    withinEdits(a.slice(i + 1), b.slice(i), next) ||
    withinEdits(a.slice(i), b.slice(i + 1), next) ||
    (transposed && withinEdits(a.slice(i + 2), b.slice(i + 2), next))
  );
}

/**
 * Parses one command's arguments.
 *
 * @throws {CliError} for an unknown flag or a value flag with no value.
 */
export function parseArgs(argv: readonly string[], spec: FlagSpec = {}): ParsedArgs {
  const booleans = new Set(spec.booleans ?? []);
  const values = new Set(spec.values ?? []);
  const aliases = spec.aliases ?? {};
  const known = [...booleans, ...values];

  const positionals: string[] = [];
  const rest: string[] = [];
  const bools = new Set<string>();
  const valued = new Map<string, string>();
  let sawSeparator = false;

  // `argv.entries()` rather than an index loop: it yields the token as a
  // `string` instead of `string | undefined`, so the body needs no guard for a
  // hole that cannot exist. A value flag consumes the next token by setting
  // `skip`.
  let skip = 0;
  for (const [index, token] of argv.entries()) {
    if (skip > 0) {
      skip -= 1;
      continue;
    }

    if (token === '--') {
      sawSeparator = true;
      rest.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf('=');
    const raw = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const name = (aliases[raw] ?? raw).replace(/^--?/, '');

    if (booleans.has(name)) {
      if (inline !== undefined) {
        throw new CliError(`the ${raw} flag takes no value`, {
          hints: [`Write ${raw} on its own.`],
        });
      }
      bools.add(name);
      continue;
    }

    if (values.has(name)) {
      const next = inline ?? argv[index + 1];
      if (next === undefined || (inline === undefined && next === '--')) {
        throw new CliError(`the ${raw} flag needs a value`, {
          hints: [`For example: ${raw} <value>`],
        });
      }
      if (inline === undefined) skip = 1;
      valued.set(name, next);
      continue;
    }

    const suggestion = nearest(name, known);
    throw new CliError(`unknown flag ${raw}`, {
      hints: [
        ...(suggestion !== undefined ? [`Did you mean --${suggestion}?`] : []),
        'Run `agentfuse --help` to see what this command accepts.',
      ],
    });
  }

  return {
    positionals,
    rest,
    sawSeparator,
    bool: (name) => bools.has(name),
    value: (name) => valued.get(name),
  };
}
