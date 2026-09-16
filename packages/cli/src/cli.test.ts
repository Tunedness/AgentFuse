import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS, PHASE_6B_COMMANDS, run, usage } from './cli.js';
import { CliError } from './errors.js';
import { CLI_VERSION, versionBanner } from './index.js';
import { type CliContext, StringWriter } from './io.js';

// These tests spawn real processes over real pipes, so their wall clock is the
// machine's, not the code's. Vitest's 5 s default is enough in isolation and
// too tight under a loaded full-suite run — which shows up as a random red
// build rather than as a bug. The assertions are about behaviour, never speed.
vi.setConfig({ testTimeout: 20_000 });

let root: string;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentfuse-cli-'));
  stdout = new StringWriter();
  stderr = new StringWriter();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function context(argv: readonly string[]): CliContext {
  return { argv, stdout, stderr, env: {}, cwd: root };
}

describe('run', () => {
  it('prints the versions of the three packages that shipped together', async () => {
    expect(await run(context(['--version']))).toBe(0);
    expect(stdout.text).toBe(`${versionBanner()}\n`);
    expect(stdout.text).toContain(CLI_VERSION);
  });

  it('accepts -v as well', async () => {
    expect(await run(context(['-v']))).toBe(0);
    expect(stdout.text).toContain('agentfuse');
  });

  it('prints the usage for --help and -h, and exits zero', async () => {
    expect(await run(context(['--help']))).toBe(0);
    const long = stdout.text;
    stdout.clear();

    expect(await run(context(['-h']))).toBe(0);
    expect(stdout.text).toBe(long);
    expect(long).toContain('Usage: agentfuse <command>');
  });

  it('names every command in the usage text', async () => {
    await run(context(['--help']));

    for (const command of COMMANDS) expect(stdout.text).toContain(command);
  });

  it('documents the policy search order where somebody will read it', async () => {
    await run(context(['--help']));

    expect(stdout.text).toContain('--policy, then AGENTFUSE_POLICY, then fusepolicy.yaml');
    expect(stdout.text).toContain('searched upwards');
    expect(stdout.text).toContain('mode: warn');
  });

  it('prints the usage and exits non-zero when given nothing', async () => {
    // A shell script that runs `agentfuse` and checks the exit code should not
    // be told it worked.
    expect(await run(context([]))).toBe(2);
    expect(stdout.lines).toEqual(usage().filter((line) => line !== ''));
    expect(stderr.text).toBe('');
  });

  it('turns a CliError into a message, hints and an exit code — with no stack', async () => {
    const code = await run(context(['frobnicate']));

    expect(code).toBe(2);
    expect(stderr.text).toBe(
      'agentfuse: unknown command: frobnicate\n' +
        `  The commands are: ${COMMANDS.join(', ')}.\n` +
        '  Run `agentfuse --help` for what each one does.\n',
    );
    expect(stderr.text).not.toContain('    at ');
    expect(stdout.text).toBe('');
  });

  it('lets a bug in AgentFuse escape with its stack intact', async () => {
    // A `CliError` is a message for the user; anything else is a defect, and
    // hiding its stack would be hiding the only useful thing about it.
    const exploding: CliContext = {
      ...context(['init']),
      get cwd(): string {
        throw new TypeError('not a CliError');
      },
    };

    await expect(run(exploding)).rejects.toThrow(TypeError);
  });

  it('passes the policy exit code through from a command', async () => {
    writeFileSync(join(root, 'fusepolicy.yaml'), 'version: 1\nbudgts: {}\n', 'utf8');

    expect(await run(context(['validate']))).toBe(3);
    expect(stderr.text).toContain('unrecognized key');
  });
});

describe('the commands the table names', () => {
  it('leaves none of them unimplemented', () => {
    // Phase 6a kept `wrap` and `serve` in the table and refused them with an
    // exit code, so that `agentfuse wrap` did not look like a misspelling.
    // Phase 6b wired both up and this list emptied, which is the state the
    // check below then has to find.
    expect([...PHASE_6B_COMMANDS]).toEqual([]);
  });

  it('is the check that would notice if one were added back', async () => {
    const refused: string[] = [];
    for (const command of COMMANDS) {
      stderr.clear();
      await run(context([command, '--help']));
      if (stderr.text.includes('not implemented yet')) refused.push(command);
    }

    expect(refused).toEqual([...PHASE_6B_COMMANDS]);
  });

  it('routes wrap far enough to fail on the missing policy, not on the name', async () => {
    // No policy anywhere above a fresh temp directory, so the command reaches
    // `loadPolicy` and stops there. What matters is that it got that far: a
    // command that is not in the table never runs at all.
    const code = await run(context(['wrap', '--', 'node', 'server.mjs']));

    expect(code).toBe(2);
    expect(stderr.text).not.toContain('unknown command');
    expect(stderr.text).toContain('fusepolicy.yaml');
  });

  it('routes serve the same way', async () => {
    const code = await run(context(['serve', '--', 'node', 'server.mjs']));

    expect(code).toBe(2);
    expect(stderr.text).toContain('fusepolicy.yaml');
  });
});

describe('dispatch', () => {
  it('routes init, and the file it writes lands in the context`s cwd', async () => {
    expect(await run(context(['init']))).toBe(0);

    expect(existsSync(join(root, 'fusepolicy.yaml'))).toBe(true);
  });

  it('routes validate, over the file init just wrote', async () => {
    await run(context(['init']));
    stdout.clear();

    expect(await run(context(['validate']))).toBe(0);
    expect(stdout.text).toContain('is a valid FusePolicy');
  });

  it('routes report', async () => {
    await run(context(['init']));
    stdout.clear();

    expect(await run(context(['report', 'list']))).toBe(0);
    expect(stdout.text).toContain('No trip reports in');
  });

  it('routes models, and awaits it', async () => {
    // The only asynchronous command, so the `await` in dispatch is load-bearing:
    // without it the promise would be returned as an exit code.
    const code = await run(context(['models']));

    expect(code).toBe(2);
    expect(stdout.text).toContain('Usage: agentfuse models install');
  });

  it('passes a command`s own flags through untouched', async () => {
    await run(context(['init', '--policy', 'custom.yaml']));

    expect(existsSync(join(root, 'custom.yaml'))).toBe(true);
  });

  it('reports a flag typo with a suggestion, through the command`s own parser', async () => {
    const code = await run(context(['init', '--polciy', 'x.yaml']));

    expect(code).toBe(2);
    expect(stderr.text).toContain('Did you mean --policy?');
  });
});

describe('the whole thing, end to end', () => {
  it('init then validate then report, with only strings crossing the boundary', async () => {
    expect(await run(context(['init']))).toBe(0);
    stdout.clear();
    expect(await run(context(['validate', '--json']))).toBe(0);

    const summary = JSON.parse(stdout.text) as {
      valid: boolean;
      reportDir: string;
    };
    expect(summary.valid).toBe(true);
    expect(summary.reportDir).toBe(join(root, '.agentfuse', 'reports'));

    stdout.clear();
    expect(await run(context(['report', 'list']))).toBe(0);
    expect(stdout.text).toContain(summary.reportDir);
  });
});

describe('the binary', () => {
  const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

  it.runIf(existsSync(MAIN))('runs as a real process and prints its version', async () => {
    // The one thing a `CliContext` cannot prove: that the entry point binds
    // the real streams, that the top-level await survives the build, and that
    // the shebang is there. Skipped when `dist/` has not been built — the gate
    // runs `typecheck` and `build` before `test`, so in CI it never is.
    const { stdout: out } = await promisify(execFile)(process.execPath, [MAIN, '--version']);

    expect(out.trim()).toBe(versionBanner());
  });

  it.runIf(existsSync(MAIN))('sets a non-zero exit code without throwing', async () => {
    let failure: (Error & { code?: number; stderr?: string }) | undefined;
    try {
      await promisify(execFile)(process.execPath, [MAIN, 'frobnicate']);
    } catch (error) {
      failure = error as Error & { code?: number; stderr?: string };
    }

    expect(failure?.code).toBe(2);
    expect(failure?.stderr).toContain('unknown command: frobnicate');
  });

  it('is declared as the package`s bin entry', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { bin?: Record<string, string> };

    // Without the `./`, deliberately. npm's own normaliser strips the prefix
    // on the way to the registry and warns `"bin[agentfuse]" script name
    // dist/main.js was invalid and removed` while doing it — a message that
    // reads like the bin entry is being dropped, on every publish, forever.
    // Nothing is dropped; the fix is to write the path npm is going to write.
    expect(manifest.bin?.agentfuse).toBe('dist/main.js');
  });

  it('starts with a shebang, so npm can link it', () => {
    const source = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');

    expect(source.split('\n')[0]).toBe('#!/usr/bin/env node');
  });
});

describe('CliError', () => {
  it('is what the dispatcher catches, and nothing else', () => {
    // Pinned here because the contract between every command and `run` is
    // exactly this: throw a `CliError` for anything a user can fix.
    expect(new CliError('x')).toBeInstanceOf(Error);
    expect(new CliError('x').exitCode).toBe(2);
  });
});
