import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePolicy } from '@agentfuse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { CliError } from '../errors.js';
import { type CliContext, StringWriter } from '../io.js';
import { validateAgainstSchema } from '../testing/json-schema.js';
import { DEFAULT_POLICY_FILENAME, initHelp, runInit, SCHEMA_URL, starterPolicy } from './init.js';

/**
 * The published JSON Schema, read from core's committed copy.
 *
 * Deliberately not the Zod schema: `z.toJSONSchema` is a projection of it, and
 * a starter file that the runtime accepts while an editor underlines it in red
 * is exactly the failure this file exists to prevent.
 */
const PUBLISHED_SCHEMA: Record<string, unknown> = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../core/schemas/fusepolicy.v1.schema.json', import.meta.url)),
    'utf8',
  ),
);

let root: string;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentfuse-init-'));
  stdout = new StringWriter();
  stderr = new StringWriter();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function context(): CliContext {
  return { argv: [], stdout, stderr, env: {}, cwd: root };
}

describe('the starter policy', () => {
  it('validates against the published JSON Schema', () => {
    const document: unknown = parseYaml(starterPolicy());

    expect(validateAgainstSchema(document, PUBLISHED_SCHEMA)).toEqual([]);
  });

  it('also validates at runtime, through the Zod schema the file was generated from', () => {
    // Both, because they are two artefacts and either one can be the wrong one.
    expect(() => parsePolicy(parseYaml(starterPolicy()))).not.toThrow();
  });

  it('points at the schema URL core actually publishes', () => {
    expect(SCHEMA_URL).toBe(PUBLISHED_SCHEMA.$id);
    expect(starterPolicy()).toContain(`# yaml-language-server: $schema=${SCHEMA_URL}`);
  });

  it('carries the schema line first, where a language server looks for it', () => {
    expect(starterPolicy().split('\n')[0]).toBe(`# yaml-language-server: $schema=${SCHEMA_URL}`);
  });

  it('starts in warn mode, stated rather than defaulted', () => {
    // The PRD's first-listed risk is a false positive breaking a working agent
    // and burning the user's trust. Writing the line out means turning it up is
    // an edit to something visible, not the discovery of a default.
    expect(starterPolicy()).toMatch(/^mode: warn$/m);
    expect(parsePolicy(parseYaml(starterPolicy())).mode).toBe('warn');
  });

  it('carries max_usd_estimated with the honesty note beside it', () => {
    // ADR-007: the PRD promises a USD limit, so the line is there; the caveat
    // above it is what keeps the promise from being a lie. The proxy sees tool
    // I/O and never the model's own tokens.
    const source = starterPolicy();
    const lines = source.split('\n');
    const index = lines.findIndex((line) => line.startsWith('  max_usd_estimated:'));

    expect(index).toBeGreaterThan(0);
    const preamble = lines.slice(Math.max(0, index - 14), index).join('\n');
    expect(preamble).toContain('ESTIMATES');
    expect(preamble).toContain('FLOOR');
    expect(preamble).toMatch(/does NOT see|never sees/);
    expect(preamble).toContain('never as an invoice');
  });

  it('explains the two exact limits before the two estimated ones', () => {
    // ADR-007: `max_duration` and `max_calls` are exactly measurable, and the
    // documentation is to explain those first.
    const source = starterPolicy();

    expect(source.indexOf('max_duration')).toBeLessThan(source.indexOf('max_tokens_estimated'));
    expect(source.indexOf('max_calls:')).toBeLessThan(source.indexOf('max_usd_estimated'));
    expect(source).toContain('These two are exact');
  });

  it('says the semantic tier needs a second install, and what happens without it', () => {
    const source = starterPolicy();

    expect(source).toContain('npm install @agentfuse/embeddings-local');
    expect(source).toContain('agentfuse models install');
    expect(source).toContain('provider: none');
    // Both halves of the decision table, where the reader will meet them.
    expect(source).toMatch(/mode: warn` prints a warning and carries on/);
    expect(source).toMatch(/mode: enforce` refuses to start/);
  });

  it('says a relative report.dir is resolved against the file', () => {
    expect(starterPolicy()).toContain('THIS');
    expect(parsePolicy(parseYaml(starterPolicy())).report.dir).toBe('.agentfuse/reports');
  });

  it('declares the pricing table the USD estimate is derived from', () => {
    const policy = parsePolicy(parseYaml(starterPolicy()));

    expect(policy.pricing.input_per_mtok_usd).toBe(3);
    expect(policy.pricing.output_per_mtok_usd).toBe(15);
    expect(starterPolicy()).toContain('these are your numbers');
  });

  it('resolves to the same policy as `version: 1` except where it says otherwise', () => {
    // A starter file is a teaching document: every value written out should be
    // the schema's own default, so that raising a limit needs no documentation
    // lookup. The two exceptions are commented in the file itself.
    const starter = parsePolicy(parseYaml(starterPolicy()));
    const bare = parsePolicy({ version: 1 });

    expect(starter.budgets.on_exceeded).toBe('halt');
    expect(bare.budgets.on_exceeded).toBe('require_approval');
    expect({
      ...starter,
      budgets: { ...starter.budgets, on_exceeded: 'require_approval' },
    }).toEqual(bare);
  });
});

describe('the schema validator this file leans on', () => {
  it('rejects a misspelled key, so an empty problem list means something', () => {
    const problems = validateAgainstSchema({ version: 1, budgts: {} }, PUBLISHED_SCHEMA);

    expect(problems.join('\n')).toContain('unexpected key budgts');
  });

  it.each([
    ['a missing version', { mode: 'warn' }, 'missing required key version'],
    ['a wrong version', { version: 2 }, 'expected 1'],
    ['a bad mode', { version: 1, mode: 'enfroce' }, 'expected one of warn, enforce'],
    ['a bad duration', { version: 1, budgets: { max_duration: '30 minutes' } }, 'allowed forms'],
    ['a non-integer count', { version: 1, budgets: { max_calls: 1.5 } }, 'expected integer'],
    [
      'a threshold above one',
      { version: 1, loop_detection: { semantic: { threshold: 2 } } },
      'maximum',
    ],
    [
      'a rule with no action',
      { version: 1, tools: [{ match: '*' }] },
      'missing required key action',
    ],
    [
      'a rule with a bad action',
      { version: 1, tools: [{ match: '*', action: 'nope' }] },
      'expected one of',
    ],
    ['the wrong type entirely', { version: 1, tools: 'all' }, 'expected array'],
  ])('rejects %s', (_label, document, expected) => {
    expect(validateAgainstSchema(document, PUBLISHED_SCHEMA).join('\n')).toContain(expected);
  });

  it('accepts the minimal policy', () => {
    expect(validateAgainstSchema({ version: 1 }, PUBLISHED_SCHEMA)).toEqual([]);
  });
});

describe('runInit', () => {
  it('writes the starter policy to fusepolicy.yaml', () => {
    const code = runInit(context(), []);

    expect(code).toBe(0);
    const path = join(root, DEFAULT_POLICY_FILENAME);
    expect(readFileSync(path, 'utf8')).toBe(starterPolicy());
    expect(stdout.text).toContain(`Wrote ${DEFAULT_POLICY_FILENAME}`);
    expect(stdout.text).toContain('mode: warn');
    expect(stderr.text).toBe('');
  });

  it('writes where --policy says, creating directories on the way', () => {
    const code = runInit(context(), ['--policy', 'config/agentfuse/fusepolicy.yaml']);

    expect(code).toBe(0);
    expect(existsSync(join(root, 'config/agentfuse/fusepolicy.yaml'))).toBe(true);
  });

  it('takes an absolute --policy as written', () => {
    const path = join(root, 'absolute.yaml');

    runInit(context(), ['--policy', path]);

    expect(existsSync(path)).toBe(true);
  });

  it('refuses to overwrite, and says how to', () => {
    writeFileSync(join(root, DEFAULT_POLICY_FILENAME), 'version: 1\n', 'utf8');

    try {
      runInit(context(), []);
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as CliError).message).toContain('already exists');
      expect((error as CliError).hints.join(' ')).toContain('--force');
      expect((error as CliError).hints.join(' ')).toContain('agentfuse validate');
    }
    // And the file it refused to touch is untouched.
    expect(readFileSync(join(root, DEFAULT_POLICY_FILENAME), 'utf8')).toBe('version: 1\n');
  });

  it('overwrites with --force', () => {
    writeFileSync(join(root, DEFAULT_POLICY_FILENAME), 'version: 1\n', 'utf8');

    expect(runInit(context(), ['--force'])).toBe(0);
    expect(readFileSync(join(root, DEFAULT_POLICY_FILENAME), 'utf8')).toBe(starterPolicy());
  });

  it('accepts the short flags', () => {
    writeFileSync(join(root, 'p.yaml'), 'old', 'utf8');

    expect(runInit(context(), ['-p', 'p.yaml', '-f'])).toBe(0);
    expect(readFileSync(join(root, 'p.yaml'), 'utf8')).toBe(starterPolicy());
  });

  it('prints help without writing anything', () => {
    expect(runInit(context(), ['--help'])).toBe(0);
    expect(stdout.lines).toEqual(initHelp().filter((line) => line !== ''));
    expect(existsSync(join(root, DEFAULT_POLICY_FILENAME))).toBe(false);
  });

  it('says what to do next, including the second install', () => {
    runInit(context(), []);

    expect(stdout.text).toContain('agentfuse validate');
    expect(stdout.text).toContain('agentfuse wrap');
    expect(stdout.text).toContain('@agentfuse/embeddings-local');
  });

  it('reports a write it cannot do, with the runtime exit code', () => {
    const blocked = join(root, 'blocked');
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'file'), '', 'utf8');

    try {
      // A file where a directory has to be.
      runInit(context(), ['--policy', 'blocked/file/fusepolicy.yaml']);
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as CliError).message).toContain('cannot write');
      expect((error as CliError).exitCode).toBe(70);
      expect((error as CliError).cause).toBeDefined();
    }
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => runInit(context(), ['--overwrite'])).toThrow(/unknown flag/);
  });
});
