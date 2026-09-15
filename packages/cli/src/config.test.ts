import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findPolicyFile,
  loadPolicy,
  noPolicyError,
  POLICY_ENV_VAR,
  POLICY_FILENAMES,
  PolicyFileError,
  readPolicyFile,
  resolveFromPolicy,
} from './config.js';
import { CliError } from './errors.js';

let root: string;

beforeEach(() => {
  // A real directory tree, because the search walks parents and the whole
  // point of the search order is which file on disk wins.
  root = mkdtempSync(join(tmpdir(), 'agentfuse-config-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes a file under the fixture root, creating directories as needed. */
function write(relative: string, contents: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return path;
}

const MINIMAL = 'version: 1\n';

describe('the policy file search order', () => {
  it('prefers --policy over everything else', () => {
    const named = write('elsewhere/custom.yaml', MINIMAL);
    write('fusepolicy.yaml', MINIMAL);

    const found = findPolicyFile({ flag: 'elsewhere/custom.yaml', cwd: root });

    expect(found).toEqual({ path: named, origin: 'flag' });
  });

  it('takes an absolute --policy as written', () => {
    const named = write('abs.yaml', MINIMAL);

    expect(findPolicyFile({ flag: named, cwd: root })?.path).toBe(named);
  });

  it('fails rather than searching when --policy names a file that is not there', () => {
    write('fusepolicy.yaml', MINIMAL);

    // Deliberately not a fallback. Silently enforcing a different policy than
    // the one the operator named is the worst outcome available to a tool
    // whose whole job is enforcing limits.
    expect(() => findPolicyFile({ flag: 'missing.yaml', cwd: root })).toThrow(CliError);
    expect(() => findPolicyFile({ flag: 'missing.yaml', cwd: root })).toThrow(
      /--policy names does not exist/,
    );
  });

  it(`falls back to ${POLICY_ENV_VAR}`, () => {
    const named = write('from-env.yaml', MINIMAL);

    const found = findPolicyFile({ env: { [POLICY_ENV_VAR]: 'from-env.yaml' }, cwd: root });

    expect(found).toEqual({ path: named, origin: 'env' });
  });

  it('fails when the environment variable names a file that is not there', () => {
    expect(() => findPolicyFile({ env: { [POLICY_ENV_VAR]: 'nope.yaml' }, cwd: root })).toThrow(
      /names a file that does not exist/,
    );
  });

  it('ignores an empty environment variable', () => {
    const inCwd = write('fusepolicy.yaml', MINIMAL);

    expect(findPolicyFile({ env: { [POLICY_ENV_VAR]: '' }, cwd: root })?.path).toBe(inCwd);
  });

  it('searches the working directory before its parents', () => {
    write('fusepolicy.yaml', MINIMAL);
    const inner = write('a/b/fusepolicy.yaml', MINIMAL);

    expect(findPolicyFile({ cwd: join(root, 'a/b') })?.path).toBe(inner);
  });

  it('walks upwards, so an agent launched in a subdirectory finds the project policy', () => {
    const top = write('fusepolicy.yaml', MINIMAL);
    mkdirSync(join(root, 'a/b/c'), { recursive: true });

    const found = findPolicyFile({ cwd: join(root, 'a/b/c') });

    expect(found).toEqual({ path: top, origin: 'search' });
  });

  it('tries every filename in the documented order within one directory', () => {
    // `.yaml` first because the docs, `init` and the schema association all
    // say `.yaml`; the rest are accepted so a user who typed one of them is
    // not told their file does not exist.
    expect(POLICY_FILENAMES).toEqual([
      'fusepolicy.yaml',
      'fusepolicy.yml',
      '.agentfuse/fusepolicy.yaml',
      '.agentfuse/fusepolicy.yml',
    ]);

    for (const [index, name] of POLICY_FILENAMES.entries()) {
      const dir = mkdtempSync(join(root, `order-${index}-`));
      // Write this candidate and every later one; the earliest must win.
      for (const later of POLICY_FILENAMES.slice(index)) {
        const path = join(dir, later);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, MINIMAL, 'utf8');
      }

      expect(findPolicyFile({ cwd: dir })?.path).toBe(join(dir, name));
    }
  });

  it('returns undefined when the walk reaches the root with nothing found', () => {
    // The fixture directory is under the OS temp dir, and a stray
    // `fusepolicy.yaml` up there would make this test lie, so the assertion is
    // about the two outcomes the function is allowed to have.
    const found = findPolicyFile({ cwd: root });

    expect(found === undefined || found.origin === 'search').toBe(true);
  });

  it('says what to do when there is no policy anywhere', () => {
    const error = noPolicyError(root);

    expect(error.message).toContain('fusepolicy.yaml');
    expect(error.message).toContain(root);
    expect(error.hints.join(' ')).toContain('agentfuse init');
    expect(error.hints.join(' ')).toContain('--policy');
  });

  it('loadPolicy reports the not-found case with that message', () => {
    const deep = join(root, 'a');
    mkdirSync(deep, { recursive: true });

    // Only assertable when nothing above the temp dir has a policy; skip the
    // assertion rather than fail on somebody's unusual machine.
    if (findPolicyFile({ cwd: deep }) === undefined) {
      expect(() => loadPolicy({ cwd: deep })).toThrow(/no fusepolicy.yaml found/);
    }
  });
});

describe('reading a policy file', () => {
  it('fills in every default from the schema, and from nowhere else', () => {
    const path = write('fusepolicy.yaml', MINIMAL);

    const loaded = readPolicyFile({ path, origin: 'flag' });

    // `mode: warn` is the schema's default and the PRD's first risk mitigation.
    expect(loaded.policy.mode).toBe('warn');
    // Durations arrive parsed to milliseconds by the schema's transform.
    expect(loaded.policy.budgets.max_duration).toBe(30 * 60_000);
    expect(loaded.policy.report.dir).toBe('.agentfuse/reports');
    expect(loaded.policy.tools).toEqual([{ match: '*', action: 'allow', idempotent: false }]);
    expect(loaded.origin).toBe('flag');
    expect(loaded.dir).toBe(resolve(root));
  });

  it('parses durations written as strings', () => {
    const path = write('fusepolicy.yaml', 'version: 1\nbudgets:\n  max_duration: 90s\n');

    expect(readPolicyFile({ path, origin: 'flag' }).policy.budgets.max_duration).toBe(90_000);
  });

  it('resolves report.dir against the policy file, not the process cwd', () => {
    // An MCP client launches `agentfuse wrap` with a working directory the
    // user did not choose, often `/`. A relative `report.dir` has to mean
    // "next to the policy that asked for it" or the reports land nowhere
    // anybody looks.
    const path = write('nested/fusepolicy.yaml', MINIMAL);
    const loaded = readPolicyFile({ path, origin: 'flag' });

    expect(resolveFromPolicy(loaded, loaded.policy.report.dir)).toBe(
      join(root, 'nested', '.agentfuse', 'reports'),
    );
  });

  it('leaves an absolute report.dir alone', () => {
    const path = write('fusepolicy.yaml', MINIMAL);
    const loaded = readPolicyFile({ path, origin: 'flag' });

    expect(resolveFromPolicy(loaded, '/var/log/agentfuse')).toBe('/var/log/agentfuse');
  });
});

describe('the message for a misspelled key', () => {
  /** The problem lines for one document. */
  function problemsFor(contents: string): readonly string[] {
    const path = write('fusepolicy.yaml', contents);
    try {
      readPolicyFile({ path, origin: 'flag' });
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyFileError);
      return (error as PolicyFileError).problems;
    }
    throw new Error('expected the document to be rejected');
  }

  it('names the key and points at its line and column', () => {
    // Zod `strict` makes a typo a hard failure at load, which is right and
    // useless if the error says only "invalid document".
    const problems = problemsFor('version: 1\nbudgets:\n  max_call: 200\n');

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('budgets.max_call');
    expect(problems[0]).toContain('unrecognized key');
    // Line 3, column 3: the key itself, not the object containing it.
    expect(problems[0]).toMatch(/fusepolicy\.yaml:3:3\b/);
  });

  it('points at a misspelled top-level key too', () => {
    const problems = problemsFor('version: 1\nbudget:\n  max_calls: 200\n');

    expect(problems[0]).toContain('budget:');
    expect(problems[0]).toMatch(/:2:1\b/);
  });

  it('reports every misspelling in one pass, not just the first', () => {
    const problems = problemsFor('version: 1\nmode: warn\nbudgts: {}\nrepot: {}\n');

    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('budgts');
    expect(problems.join('\n')).toContain('repot');
  });

  it('names the location of a wrong value, with the schema`s own message', () => {
    const problems = problemsFor('version: 1\nmode: enfroce\n');

    expect(problems[0]).toContain('mode:');
    expect(problems[0]).toMatch(/:2:7\b/);
    expect(problems[0]).toMatch(/enforce/);
  });

  it('locates a problem inside a list element', () => {
    const problems = problemsFor(
      'version: 1\ntools:\n  - match: "*"\n    action: allow\n  - match: "fs__*"\n    action: nope\n',
    );

    expect(problems[0]).toContain('tools[1].action');
    expect(problems[0]).toMatch(/:6:13\b/);
  });

  it('points somewhere useful even when the node cannot be located', () => {
    // A missing key has no node to point at, so the line number is dropped
    // rather than invented.
    const problems = problemsFor('mode: warn\n');

    expect(problems[0]).toContain('version');
  });

  it('offers the schema line as the way to catch this in an editor first', () => {
    const path = write('fusepolicy.yaml', 'version: 1\nbudgets:\n  max_call: 1\n');

    try {
      readPolicyFile({ path, origin: 'flag' });
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as PolicyFileError).hints.join(' ')).toContain('yaml-language-server');
    }
  });
});

describe('the message for malformed YAML', () => {
  it('says the file is not valid YAML, and does not produce a Zod dump', () => {
    const path = write('fusepolicy.yaml', 'version: 1\nbudgets:\n  max_calls: [1, 2\n');

    try {
      readPolicyFile({ path, origin: 'flag' });
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyFileError);
      const failure = error as PolicyFileError;
      expect(failure.message).toContain('is not valid YAML');
      expect(failure.message).not.toContain('FusePolicy');
      expect(failure.problems.join('\n')).toMatch(/fusepolicy\.yaml:\d+:\d+/);
      expect(failure.hints.join(' ')).toContain('indentation-sensitive');
    }
  });

  it('reports a duplicate key as a YAML problem, not a schema one', () => {
    const path = write('fusepolicy.yaml', 'version: 1\nmode: warn\nmode: enforce\n');

    expect(() => readPolicyFile({ path, origin: 'flag' })).toThrow(/is not valid YAML/);
  });

  it('reports a tab-indented document as YAML, with a position', () => {
    const path = write('fusepolicy.yaml', 'version: 1\nbudgets:\n\tmax_calls: 1\n');

    try {
      readPolicyFile({ path, origin: 'flag' });
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as PolicyFileError).message).toContain('is not valid YAML');
    }
  });

  it('rejects an alias bomb as malformed input rather than letting it throw', () => {
    // `document.toJS()` is the step that throws — `parseDocument` only
    // collects. An unhandled `ReferenceError` here would reach the user as a
    // stack trace about AgentFuse's internals.
    const path = write(
      'fusepolicy.yaml',
      [
        'version: 1',
        'a: &a ["x","x","x","x","x","x","x","x","x"]',
        'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
        'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
        'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
        '',
      ].join('\n'),
    );

    try {
      readPolicyFile({ path, origin: 'flag' });
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyFileError);
      expect((error as PolicyFileError).message).toContain('is not valid YAML');
      expect((error as PolicyFileError).problems.join('\n')).toContain('alias');
    }
  });

  it('rejects an unresolved alias the same way', () => {
    const path = write('fusepolicy.yaml', 'version: 1\nmode: *missing\n');

    expect(() => readPolicyFile({ path, origin: 'flag' })).toThrow(PolicyFileError);
  });

  it('says so when the document is not a mapping at all', () => {
    const path = write('fusepolicy.yaml', '- version: 1\n');

    try {
      readPolicyFile({ path, origin: 'flag' });
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as PolicyFileError).message).toContain('not a FusePolicy document');
      expect((error as PolicyFileError).problems.join('\n')).toContain('a list');
    }
  });

  it('says so when the document is a bare scalar', () => {
    const path = write('fusepolicy.yaml', 'just-a-string\n');

    expect(() => readPolicyFile({ path, origin: 'flag' })).toThrow(/not a FusePolicy document/);
  });

  it('says an empty file is empty, rather than invalid', () => {
    const path = write('fusepolicy.yaml', '# nothing but a comment\n');

    try {
      readPolicyFile({ path, origin: 'flag' });
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as PolicyFileError).message).toContain('is empty');
      expect((error as PolicyFileError).hints.join(' ')).toContain('version: 1');
    }
  });

  it('says so when the file cannot be read at all', () => {
    try {
      readPolicyFile({ path: join(root, 'a-directory-that-is-not-a-file'), origin: 'flag' });
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as PolicyFileError).message).toContain('cannot read the policy file');
    }
  });

  it('uses the policy exit code for every one of these', () => {
    const path = write('fusepolicy.yaml', 'version: 2\n');

    try {
      readPolicyFile({ path, origin: 'flag' });
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as PolicyFileError).exitCode).toBe(3);
    }
  });
});

describe('loadPolicy', () => {
  it('finds and reads in one step', () => {
    write('fusepolicy.yaml', 'version: 1\nmode: enforce\n');

    const loaded = loadPolicy({ cwd: root });

    expect(loaded.policy.mode).toBe('enforce');
    expect(loaded.origin).toBe('search');
  });
});
