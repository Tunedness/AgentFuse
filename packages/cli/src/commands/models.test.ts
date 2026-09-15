import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMBEDDINGS_PACKAGE, type EmbeddingsLoader, type InstallProgress } from '../embeddings.js';
import type { CliError } from '../errors.js';
import { type CliContext, StringWriter } from '../io.js';
import { DEFAULT_MODEL, modelsHelp, runModels } from './models.js';

let root: string;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentfuse-models-'));
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

function context(): CliContext {
  return { argv: [], stdout, stderr, env: {}, cwd: root };
}

/** The loader shape for a package that is not installed. */
const missing: EmbeddingsLoader = async () => {
  const error = new Error(`Cannot find package '${EMBEDDINGS_PACKAGE}' imported from /somewhere`);
  (error as Error & { code?: string }).code = 'ERR_MODULE_NOT_FOUND';
  throw error;
};

/** A loader whose installer records what it was asked for. */
function installer(options: { asked: string[]; progress?: readonly InstallProgress[] }) {
  const load: EmbeddingsLoader = async () => ({
    installModel: async (request: {
      model: string;
      onProgress?: (progress: InstallProgress) => void;
    }) => {
      options.asked.push(request.model);
      for (const step of options.progress ?? []) request.onProgress?.(step);
      return { path: join(root, 'cache', request.model), bytes: 23_000_000 };
    },
  });
  return load;
}

describe('runModels install when the package is not there', () => {
  it('names the package and the command that installs it, and exits 4', async () => {
    // This is the common case today, and phase 4 is deliberately not built
    // yet, so this message is the command's main product.
    let caught: CliError | undefined;
    try {
      await runModels(context(), ['install'], missing);
    } catch (error) {
      caught = error as CliError;
    }

    expect(caught?.message).toBe(`${EMBEDDINGS_PACKAGE} is not installed`);
    expect(caught?.exitCode).toBe(4);
    expect(caught?.hints.join(' ')).toContain(`npm install ${EMBEDDINGS_PACKAGE}`);
  });

  it('explains why it is a separate install rather than a dependency', async () => {
    let caught: CliError | undefined;
    try {
      await runModels(context(), ['install'], missing);
    } catch (error) {
      caught = error as CliError;
    }

    expect(caught?.hints.join(' ')).toContain('301 MB');
    expect(caught?.hints.join(' ')).toContain('onnxruntime-node');
    // And no internal document numbers: a user reading this has never seen
    // the ADRs and does not need to.
    expect(caught?.hints.join(' ')).not.toMatch(/ADR-\d/);
  });

  it('is not a stack trace and not a silent no-op', async () => {
    let caught: CliError | undefined;
    try {
      await runModels(context(), ['install'], missing);
    } catch (error) {
      caught = error as CliError;
    }

    // The underlying resolver message is quoted as a hint, not raised as a
    // `ERR_MODULE_NOT_FOUND` the user has to decode.
    expect(caught?.name).toBe('CliError');
    expect(caught?.hints.some((hint) => hint.includes('Cannot find package'))).toBe(true);
    // Nothing was printed as if it had worked.
    expect(stdout.text).not.toContain('Installed');
  });

  it('asks for an upgrade when the package is there but exports no installer', async () => {
    // Which is exactly what phase 1's stub does, so this is the state inside
    // this monorepo today.
    let caught: CliError | undefined;
    try {
      await runModels(context(), ['install'], async () => ({ BACKEND_ID: 'local' }));
    } catch (error) {
      caught = error as CliError;
    }

    expect(caught?.message).toContain('does not export installModel');
    expect(caught?.hints.join(' ')).toContain('@latest');
  });
});

describe('runModels install when the package is there', () => {
  it('installs the model the policy names', async () => {
    write('fusepolicy.yaml', 'version: 1\nloop_detection:\n  semantic:\n    model: my/model\n');
    const asked: string[] = [];

    const code = await runModels(context(), ['install'], installer({ asked }));

    expect(code).toBe(0);
    expect(asked).toEqual(['my/model']);
    expect(stdout.text).toContain('Installed my/model');
    expect(stdout.text).toContain('23.0 MB');
  });

  it('prefers --model over the policy', async () => {
    write('fusepolicy.yaml', 'version: 1\nloop_detection:\n  semantic:\n    model: my/model\n');
    const asked: string[] = [];

    await runModels(context(), ['install', '--model', 'other/model'], installer({ asked }));

    expect(asked).toEqual(['other/model']);
  });

  it('falls back to the default model when there is no policy', async () => {
    const asked: string[] = [];

    await runModels(context(), ['install'], installer({ asked }));

    // Installing the model before writing a policy is the order `init`'s own
    // output suggests, so a missing policy must not refuse the download.
    expect(asked).toEqual([DEFAULT_MODEL]);
  });

  it('ignores a broken policy rather than refusing the download', async () => {
    write('fusepolicy.yaml', 'version: 1\nbudgts: {\n');
    const asked: string[] = [];

    expect(await runModels(context(), ['install'], installer({ asked }))).toBe(0);
    expect(asked).toEqual([DEFAULT_MODEL]);
  });

  it('reads the model from the policy --policy names', async () => {
    write('other/p.yaml', 'version: 1\nloop_detection:\n  semantic:\n    model: named/model\n');
    const asked: string[] = [];

    await runModels(context(), ['install', '--policy', 'other/p.yaml'], installer({ asked }));

    expect(asked).toEqual(['named/model']);
  });

  it('reports progress as it goes, with a percentage when there is a size', async () => {
    const asked: string[] = [];

    await runModels(
      context(),
      ['install'],
      installer({
        asked,
        progress: [
          { message: 'resolving' },
          { message: 'downloading', received: 5, total: 10 },
          { message: 'verifying sha256' },
        ],
      }),
    );

    expect(stdout.text).toContain('  resolving');
    expect(stdout.text).toContain('  downloading (50%)');
    expect(stdout.text).toContain('  verifying sha256');
  });

  it('turns a failed download into a message naming the offline switch', async () => {
    let caught: CliError | undefined;
    try {
      await runModels(context(), ['install'], async () => ({
        installModel: async () => {
          throw new Error('ENOTFOUND huggingface.co');
        },
      }));
    } catch (error) {
      caught = error as CliError;
    }

    expect(caught?.message).toContain('failed');
    expect(caught?.exitCode).toBe(70);
    expect(caught?.hints.join(' ')).toContain('ENOTFOUND');
    expect(caught?.hints.join(' ')).toContain('AGENTFUSE_OFFLINE=1');
  });

  it('says the semantic tier is now available', async () => {
    await runModels(context(), ['install'], installer({ asked: [] }));

    expect(stdout.text).toContain('Semantic loop detection is now available');
    expect(stdout.text).toContain('provider: local');
  });
});

describe('runModels argument handling', () => {
  it('prints help and exits non-zero when no subcommand is given', async () => {
    // A bare `agentfuse models` did not do anything, and a script that ignores
    // the exit code should not think it did.
    const code = await runModels(context(), []);

    expect(code).toBe(2);
    expect(stdout.text).toContain('Usage: agentfuse models install');
  });

  it('prints help and exits zero for --help', async () => {
    expect(await runModels(context(), ['--help'])).toBe(0);
    expect(stdout.lines).toEqual(modelsHelp().filter((line) => line !== ''));
  });

  it('says the deterministic rules need none of this', async () => {
    await runModels(context(), ['--help']);

    // ADR-001: no crippleware. Somebody who reads this and decides not to
    // install should know what they still have.
    expect(stdout.text).toContain('need none of this and work on a plain install');
  });

  it('rejects a subcommand it does not have', async () => {
    let caught: CliError | undefined;
    try {
      await runModels(context(), ['list']);
    } catch (error) {
      caught = error as CliError;
    }

    expect(caught?.message).toContain('unknown models subcommand: list');
    expect(caught?.hints.join(' ')).toContain('agentfuse models install');
  });
});
