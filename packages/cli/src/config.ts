/**
 * Finding, reading and validating `fusepolicy.yaml`.
 *
 * ## The pipeline
 *
 * ```
 * yaml.parseDocument → FusePolicySchemaV1.safeParse → compilePolicy (in core)
 * ```
 *
 * The defaults live in **one** place: the Zod schema in `@agentfuse/core`. This
 * file never supplies a fallback value of its own, because a second copy of the
 * defaults drifts from the first and the published JSON Schema then tells
 * people's editors something the runtime does not believe.
 *
 * ## Why the errors are built by hand here
 *
 * `parsePolicy` throws a `PolicyValidationError` carrying `path: message` lines,
 * which is right for a library. A person editing a file wants a line number.
 * So the CLI parses with `yaml`'s document API, keeps the `LineCounter`, runs
 * `safeParse` itself to get the structured issues, and maps each issue's path
 * back to the offset of the offending node. Zod `strict` means a misspelled key
 * fails at load time — this is what makes that failure say *which* key and
 * *where*, instead of only that the document is invalid.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, parse as parsePath, resolve } from 'node:path';
import { type FusePolicy, FusePolicySchemaV1 } from '@agentfuse/core';
import { isMap, isSeq, LineCounter, type Node, parseDocument } from 'yaml';
import type { z } from 'zod';
import { CliError, EXIT } from './errors.js';

/**
 * Filenames looked for in each directory of the search, in this order.
 *
 * `.yaml` before `.yml` because the documentation, the `init` command and the
 * JSON Schema association all say `.yaml`; `.yml` is accepted so that a user
 * who typed the other one is not told their file does not exist. The
 * `.agentfuse/` variants let a project keep the policy next to the reports it
 * generates instead of in the repository root.
 */
export const POLICY_FILENAMES: readonly string[] = [
  'fusepolicy.yaml',
  'fusepolicy.yml',
  '.agentfuse/fusepolicy.yaml',
  '.agentfuse/fusepolicy.yml',
];

/** The environment variable that names a policy file. */
export const POLICY_ENV_VAR = 'AGENTFUSE_POLICY';

/** How a policy file was found. Reported in diagnostics so it is never a mystery. */
export type PolicyOrigin = 'flag' | 'env' | 'search';

/** A policy file located but not yet read. */
export interface PolicyLocation {
  /** Absolute path. */
  readonly path: string;
  readonly origin: PolicyOrigin;
}

/** A validated policy and where it came from. */
export interface LoadedPolicy {
  readonly policy: FusePolicy;
  /** Absolute path of the file. */
  readonly path: string;
  readonly origin: PolicyOrigin;
  /**
   * Directory the file lives in.
   *
   * Relative paths inside the policy — `report.dir`, above all — resolve
   * against this and **not** against the process's cwd. An MCP client launches
   * `agentfuse wrap` with a working directory the user did not choose (often
   * `/`), so a `report.dir` of `.agentfuse/reports` has to mean "next to the
   * policy that asked for it" or the reports land somewhere nobody looks.
   */
  readonly dir: string;
}

/** A policy file that could not be read or did not validate. */
export class PolicyFileError extends CliError {
  /** One rendered `file:line:col  path: message` line per problem. */
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[], hints: readonly string[] = []) {
    super(message, { exitCode: EXIT.policy, hints: [...problems, ...hints] });
    this.name = 'PolicyFileError';
    this.problems = problems;
  }
}

/** Where {@link findPolicyFile} is allowed to look. */
export interface FindPolicyOptions {
  /** The `--policy` flag, if given. Relative to `cwd`. */
  readonly flag?: string | undefined;
  /** The process environment. Read for {@link POLICY_ENV_VAR}. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly cwd: string;
}

/**
 * Locates the policy file.
 *
 * The order, and the reasoning for it:
 *
 * 1. `--policy <path>` — an explicit instruction. A path that does not exist is
 *    an error and **never** falls through to the search: silently using a
 *    different policy than the one the operator named is the worst possible
 *    outcome for a tool whose job is enforcing limits.
 * 2. `AGENTFUSE_POLICY` — same strictness, and necessary rather than merely
 *    convenient: an MCP client's server configuration lets the user set `env`
 *    and `args`, but the working directory is often not theirs to choose, so an
 *    environment variable is sometimes the only channel there is.
 * 3. `fusepolicy.yaml` walking up from `cwd` to the filesystem root, taking the
 *    first directory that has one. Upwards, because a repository's policy
 *    should apply to an agent launched in any of its subdirectories — the same
 *    reasoning as `tsconfig.json` or `.editorconfig`. All the way up rather
 *    than stopping at a `.git` boundary, so a user can put a personal default
 *    in their home directory; the resolved absolute path is always reported, so
 *    a surprising pick is visible rather than mysterious.
 *
 * @returns the location, or `undefined` when the search found nothing.
 * @throws {CliError} when an explicitly named file does not exist.
 */
export function findPolicyFile(options: FindPolicyOptions): PolicyLocation | undefined {
  const { flag, cwd } = options;
  const env = options.env ?? {};

  if (flag !== undefined) {
    const path = isAbsolute(flag) ? flag : resolve(cwd, flag);
    if (!existsSync(path)) {
      throw new CliError(`the policy file --policy names does not exist: ${path}`, {
        hints: ['Check the path, or drop the flag to search from the working directory.'],
      });
    }
    return { path, origin: 'flag' };
  }

  const fromEnv = env[POLICY_ENV_VAR];
  if (fromEnv !== undefined && fromEnv !== '') {
    const path = isAbsolute(fromEnv) ? fromEnv : resolve(cwd, fromEnv);
    if (!existsSync(path)) {
      throw new CliError(`${POLICY_ENV_VAR} names a file that does not exist: ${path}`, {
        hints: [`Unset ${POLICY_ENV_VAR} or point it at an existing policy file.`],
      });
    }
    return { path, origin: 'env' };
  }

  let directory = resolve(cwd);
  const root = parsePath(directory).root;
  for (;;) {
    for (const name of POLICY_FILENAMES) {
      const candidate = resolve(directory, name);
      if (existsSync(candidate)) return { path: candidate, origin: 'search' };
    }
    if (directory === root) return undefined;
    const parent = dirname(directory);
    // `dirname('/')` is `'/'`; the root comparison above normally stops first,
    // but a UNC or otherwise unusual root could make it not, and an infinite
    // loop in a policy search is a bad way to find that out.
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** The message shown when no policy file exists anywhere. */
export function noPolicyError(cwd: string): CliError {
  return new CliError(`no ${POLICY_FILENAMES[0]} found in ${cwd} or any parent directory`, {
    hints: [
      'Run `agentfuse init` to write a starter policy (it defaults to mode: warn).',
      'Or name one explicitly with --policy <path>.',
    ],
  });
}

/** `line:col` for a byte offset, or `undefined` when there is no counter. */
function position(counter: LineCounter, offset: number | undefined): string {
  if (offset === undefined) return '';
  const { line, col } = counter.linePos(offset);
  return `:${line}:${col}`;
}

/**
 * The offset of the node a Zod issue is about.
 *
 * `extraKey` is for `unrecognized_keys`, whose `path` points at the *containing*
 * object — the offending key is in `issue.keys`, and pointing a line number at
 * the object instead of the misspelling would be a worse error message than no
 * line number at all.
 */
function offsetOf(
  document: ReturnType<typeof parseDocument>,
  path: readonly PropertyKey[],
  extraKey?: string,
): number | undefined {
  const container = path.length === 0 ? document.contents : document.getIn(path as never, true);
  const node = container as Node | null | undefined;
  if (node === null || node === undefined) return undefined;

  if (extraKey !== undefined && isMap(node)) {
    for (const item of node.items) {
      const key = item.key as { value?: unknown; range?: readonly number[] } | null;
      if (key !== null && key?.value === extraKey) return key.range?.[0];
    }
  }

  if (isMap(node) || isSeq(node)) return node.range?.[0];
  return (node as { range?: readonly number[] }).range?.[0];
}

/** `budgets.max_calls` / `tools[0].action` / `<root>`, matching core's format. */
function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '<root>';
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/** Turns one Zod issue into as many human lines as it names problems. */
function renderIssue(
  issue: z.core.$ZodIssue,
  file: string,
  document: ReturnType<typeof parseDocument>,
  counter: LineCounter,
): string[] {
  const base = formatPath(issue.path);

  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => {
      const where = position(counter, offsetOf(document, issue.path, key));
      const full = base === '<root>' ? key : `${base}.${key}`;
      return `${file}${where}  ${full}: unrecognized key — this setting does not exist`;
    });
  }

  const where = position(counter, offsetOf(document, issue.path));
  return [`${file}${where}  ${base}: ${issue.message}`];
}

/**
 * Reads and validates one policy file.
 *
 * @throws {PolicyFileError} for unreadable, malformed or invalid documents.
 */
export function readPolicyFile(location: PolicyLocation): LoadedPolicy {
  const { path, origin } = location;

  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    throw new PolicyFileError(
      `cannot read the policy file ${path}`,
      [error instanceof Error ? error.message : String(error)],
      ['Check the path and the file permissions.'],
    );
  }

  const counter = new LineCounter();
  // `parseDocument` collects syntax problems in `document.errors` rather than
  // throwing; the throwing step is `toJS` below.
  const document = parseDocument(source, { lineCounter: counter, prettyErrors: false });

  if (document.errors.length > 0) {
    const problems = document.errors.map((error) => {
      // `error.linePos` is only filled in when `prettyErrors` is on, and
      // `prettyErrors` also rewrites `message` to carry its own copy of the
      // position plus a code frame. The offset in `error.pos` is always there,
      // so the line is computed from the same `LineCounter` the Zod issues
      // use, and every problem line in this file has one shape.
      return `${path}${position(counter, error.pos[0])}  ${error.message}`;
    });
    throw new PolicyFileError(`${path} is not valid YAML`, problems, [
      'YAML is indentation-sensitive: check that nested keys line up and that every quote and bracket is closed.',
    ]);
  }

  // Anchors and aliases are resolved here, and this is the step that throws:
  // an unresolved `*alias`, or the alias-expansion bomb `maxAliasCount` exists
  // to stop. Both are malformed input and get the malformed-input message
  // rather than a stack trace.
  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new PolicyFileError(
      `${path} is not valid YAML`,
      [`${path}  ${error instanceof Error ? error.message : String(error)}`],
      ['Check the `&anchor` and `*alias` references.'],
    );
  }

  if (raw === null || raw === undefined) {
    throw new PolicyFileError(
      `${path} is empty`,
      [],
      ['A minimal policy is one line: `version: 1`. Run `agentfuse init` for a starter file.'],
    );
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyFileError(
      `${path} is not a FusePolicy document`,
      [`${path}  the top level is ${Array.isArray(raw) ? 'a list' : `a ${typeof raw}`}`],
      [
        'A policy is a mapping of settings, starting with `version: 1`.',
        'Run `agentfuse init` for a starter file.',
      ],
    );
  }

  const result = FusePolicySchemaV1.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.flatMap((issue) =>
      renderIssue(issue, path, document, counter),
    );
    throw new PolicyFileError(`${path} is not a valid FusePolicy`, problems, [
      'The published JSON Schema is at https://schemas.tunedness.com/agentfuse/fusepolicy.v1.schema.json — adding the `# yaml-language-server: $schema=` line to the file makes an editor catch this before AgentFuse does.',
    ]);
  }

  return { policy: result.data, path, origin, dir: dirname(path) };
}

/** Finds and reads the policy in one step. */
export function loadPolicy(options: FindPolicyOptions): LoadedPolicy {
  const location = findPolicyFile(options);
  if (location === undefined) throw noPolicyError(resolve(options.cwd));
  return readPolicyFile(location);
}

/**
 * Resolves a policy-relative path, such as `report.dir`.
 *
 * Absolute paths are taken as written; a relative one is relative to the
 * policy file. See {@link LoadedPolicy.dir}.
 */
export function resolveFromPolicy(loaded: Pick<LoadedPolicy, 'dir'>, path: string): string {
  return isAbsolute(path) ? path : resolve(loaded.dir, path);
}
