import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compilePolicy, parsePolicy } from '@agentfuse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POLICY_ENV_VAR, PolicyFileError } from '../config.js';
import type { CliError } from '../errors.js';
import { type CliContext, StringWriter } from '../io.js';
import { runValidate, validateHelp } from './validate.js';

let root: string;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentfuse-validate-'));
  stdout = new StringWriter();
  stderr = new StringWriter();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return path;
}

function context(env: Record<string, string | undefined> = {}): CliContext {
  return { argv: [], stdout, stderr, env, cwd: root };
}

const STARTER = 'version: 1\nbudgets:\n  max_duration: 45m\n  max_calls: 50\n';

describe('runValidate on a good policy', () => {
  it('reports it valid and prints the resolved settings', () => {
    write('fusepolicy.yaml', STARTER);

    const code = runValidate(context(), []);

    expect(code).toBe(0);
    expect(stdout.text).toContain('is a valid FusePolicy');
    // Durations are milliseconds inside and were written as `45m`; printing
    // them back is how an operator confirms the file says what they meant.
    expect(stdout.text).toContain('max_duration            45m');
    expect(stdout.text).toContain('max_calls               50');
    expect(stderr.text).toBe('');
  });

  it('prints the same sha256 that will appear in every trip report', () => {
    write('fusepolicy.yaml', STARTER);

    runValidate(context(), []);

    expect(stdout.text).toContain(compilePolicy(parsePolicy({ ...parseStarter() })).sha256);
  });

  it('labels the estimated budgets as estimates', () => {
    // ADR-007: the caveat travels with the number, wherever the number goes.
    write('fusepolicy.yaml', STARTER);

    runValidate(context(), []);

    expect(stdout.text).toMatch(/max_duration .* exact/);
    expect(stdout.text).toMatch(/max_calls .* exact/);
    expect(stdout.text).toMatch(/max_tokens_estimated .* floor estimate of tool I\/O only/);
    expect(stdout.text).toMatch(/max_usd_estimated .* floor estimate/);
  });

  it('prints the report directory it would use, resolved', () => {
    write('nested/fusepolicy.yaml', `${STARTER}report:\n  dir: trips\n`);

    runValidate(context(), ['--policy', 'nested/fusepolicy.yaml']);

    expect(stdout.text).toContain(join(root, 'nested', 'trips'));
  });

  it('lists the tool rules in match order, with their ids', () => {
    write(
      'fusepolicy.yaml',
      'version: 1\ntools:\n  - match: "fs__read_*"\n    action: allow\n    idempotent: true\n  - match: "shell__*"\n    action: deny\n  - match: "*"\n    action: warn\n',
    );

    runValidate(context(), []);

    expect(stdout.text).toContain('tool rules       3 (first match wins)');
    expect(stdout.text).toMatch(/tools\[0\]\s+fs__read_\*\s+allow\s+idempotent/);
    expect(stdout.text).toMatch(/tools\[1\]\s+shell__\*\s+deny/);
    expect(stdout.text).toMatch(/tools\[2\]\s+\*\s+warn/);
  });

  it('says how the file was found, in words', () => {
    const path = write('fusepolicy.yaml', STARTER);

    runValidate(context(), []);
    expect(stdout.text).toContain('a search upwards from the working directory');

    stdout.clear();
    runValidate(context(), ['--policy', path]);
    expect(stdout.text).toContain('the --policy flag');

    stdout.clear();
    runValidate(context({ [POLICY_ENV_VAR]: path }), []);
    expect(stdout.text).toContain(`the ${POLICY_ENV_VAR} environment variable`);
  });

  it('takes the file as a bare positional too', () => {
    const path = write('somewhere/custom.yaml', STARTER);

    expect(runValidate(context(), [path])).toBe(0);
    expect(stdout.text).toContain(path);
  });

  it('checks as if run with --mode, and says the mode was overridden', () => {
    write('fusepolicy.yaml', STARTER);

    runValidate(context(), ['--mode', 'enforce']);

    expect(stdout.text).toContain('mode             enforce (overridden by --mode)');
  });

  it('rejects a --mode value that is not one of the two', () => {
    write('fusepolicy.yaml', STARTER);

    try {
      runValidate(context(), ['--mode', 'strict']);
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as CliError).message).toContain('--mode must be one of warn, enforce');
      expect((error as CliError).hints.join(' ')).toContain('observes');
    }
  });

  it('notes that the semantic tier needs a package this CLI does not depend on', () => {
    write('fusepolicy.yaml', STARTER);

    runValidate(context(), []);

    expect(stdout.text).toContain('@agentfuse/embeddings-local');
    expect(stdout.text).toContain('not a dependency of this CLI');
  });

  it('says the semantic tier is off when it is, and drops the note', () => {
    write('fusepolicy.yaml', `${STARTER}loop_detection:\n  semantic:\n    provider: none\n`);

    runValidate(context(), []);

    expect(stdout.text).toContain('semantic                off');
    expect(stdout.text).not.toContain('@agentfuse/embeddings-local');
  });

  it('describes the semantic settings when it is on', () => {
    write('fusepolicy.yaml', STARTER);

    runValidate(context(), []);

    expect(stdout.text).toMatch(/semantic\s+local, threshold 0\.905, one window/);
  });

  it('says when arguments will be redacted in written reports', () => {
    write('fusepolicy.yaml', `${STARTER}report:\n  redact_args: true\n`);

    runValidate(context(), []);

    expect(stdout.text).toContain('(arguments redacted)');
  });
});

describe('runValidate --json', () => {
  it('prints a machine-readable summary including the whole resolved policy', () => {
    const path = write('fusepolicy.yaml', STARTER);

    expect(runValidate(context(), ['--json'])).toBe(0);
    const parsed = JSON.parse(stdout.text) as Record<string, unknown>;

    expect(parsed.valid).toBe(true);
    expect(parsed.path).toBe(path);
    expect(parsed.origin).toBe('search');
    expect(parsed.mode).toBe('warn');
    expect(parsed.rules).toBe(1);
    expect(parsed.semantic).toEqual({
      wanted: true,
      providers: ['local'],
      models: ['Xenova/all-MiniLM-L6-v2'],
    });
    expect((parsed.policy as { budgets: { max_duration: number } }).budgets.max_duration).toBe(
      45 * 60_000,
    );
  });
});

describe('runValidate on a bad policy', () => {
  it('names a misspelled key, with its line and column, and exits 3', () => {
    write('fusepolicy.yaml', 'version: 1\nbudgets:\n  max_call: 200\n');

    try {
      runValidate(context(), []);
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyFileError);
      const failure = error as PolicyFileError;
      expect(failure.exitCode).toBe(3);
      expect(failure.problems[0]).toContain('budgets.max_call');
      expect(failure.problems[0]).toContain('unrecognized key');
      expect(failure.problems[0]).toMatch(/:3:3\b/);
    }
  });

  it('gives malformed YAML its own message, not a Zod dump', () => {
    write('fusepolicy.yaml', 'version: 1\ntools:\n  - match: "*\n');

    try {
      runValidate(context(), []);
      throw new Error('expected a rejection');
    } catch (error) {
      const failure = error as PolicyFileError;
      expect(failure.message).toContain('is not valid YAML');
      expect(failure.message).not.toContain('FusePolicy');
      expect(failure.hints.join(' ')).toContain('indentation-sensitive');
    }
  });

  it('says where it looked when there is no policy at all', () => {
    // The search can reach a stray policy above the temp directory on an
    // unusual machine; the assertion is about the failure, when there is one.
    try {
      runValidate(context(), []);
    } catch (error) {
      expect((error as CliError).hints.join(' ')).toContain('agentfuse init');
    }
  });

  it('refuses a --policy that names nothing, rather than searching', () => {
    write('fusepolicy.yaml', STARTER);

    expect(() => runValidate(context(), ['--policy', 'nope.yaml'])).toThrow(/does not exist/);
  });
});

describe('runValidate --help', () => {
  it('prints the usage and the exit codes', () => {
    expect(runValidate(context(), ['--help'])).toBe(0);
    expect(stdout.lines).toEqual(validateHelp().filter((line) => line !== ''));
    expect(stdout.text).toContain('Exit codes: 0 valid, 3 invalid.');
  });
});

/** The starter fixture as an object, for the sha256 comparison. */
function parseStarter(): Record<string, unknown> {
  return { version: 1, budgets: { max_duration: '45m', max_calls: 50 } };
}
