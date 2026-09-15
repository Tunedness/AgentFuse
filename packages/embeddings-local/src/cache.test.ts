import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheRoot, filePath, modelDir, sha256File, verifyFile } from './cache.js';
import { KNOWN_MODELS, type ModelFile, type ModelSpec } from './models.js';

const SPEC = KNOWN_MODELS['Xenova/all-MiniLM-L6-v2'] as ModelSpec;

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentfuse-cache-'));
  temporary.push(dir);
  return dir;
}

/** A pinned file over content chosen by the test. */
function pin(content: string, name = 'pinned.bin'): ModelFile {
  return {
    repoPath: name,
    name,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
  };
}

describe('cacheRoot', () => {
  it('prefers an explicit override over everything', () => {
    expect(cacheRoot({ AGENTFUSE_CACHE_DIR: '/env', XDG_CACHE_HOME: '/xdg' }, '/explicit')).toBe(
      '/explicit',
    );
  });

  it('then AGENTFUSE_CACHE_DIR, for containers and CI', () => {
    expect(cacheRoot({ AGENTFUSE_CACHE_DIR: '/env', XDG_CACHE_HOME: '/xdg' })).toBe('/env');
  });

  it('then XDG_CACHE_HOME, which ADR-003 says to honour', () => {
    expect(cacheRoot({ XDG_CACHE_HOME: '/xdg' })).toBe(join('/xdg', 'agentfuse'));
  });

  it('falls back to ~/.cache/agentfuse', () => {
    expect(cacheRoot({})).toBe(join(homedir(), '.cache', 'agentfuse'));
  });

  it('treats an empty value as unset rather than as the root directory', () => {
    // A shell that exports `XDG_CACHE_HOME=` would otherwise send the cache to
    // `/agentfuse`, which is both wrong and unwritable.
    expect(cacheRoot({ XDG_CACHE_HOME: '', AGENTFUSE_CACHE_DIR: '' }, '')).toBe(
      join(homedir(), '.cache', 'agentfuse'),
    );
  });
});

describe('the cache layout', () => {
  it('gives every revision its own directory', () => {
    // Re-pinning a model writes beside the old copy rather than over it, so a
    // bisect or two checkouts on one machine never fight over the same path.
    expect(modelDir('/root', SPEC)).toBe(
      join('/root', 'models', 'Xenova--all-MiniLM-L6-v2', SPEC.revision),
    );
  });

  it('flattens the owner/model separator so an id cannot leave the root', () => {
    expect(filePath('/root', SPEC, SPEC.onnx)).toBe(
      join('/root', 'models', 'Xenova--all-MiniLM-L6-v2', SPEC.revision, 'model_quantized.onnx'),
    );
    expect(filePath('/root', SPEC, SPEC.onnx)).not.toContain('Xenova/');
  });
});

describe('sha256File', () => {
  it('hashes the bytes on disk', async () => {
    const dir = await scratch();
    const path = join(dir, 'x');
    await writeFile(path, 'hello');

    expect(await sha256File(path)).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('verifyFile', () => {
  it('accepts a file that matches its pin', async () => {
    const dir = await scratch();
    const path = join(dir, 'pinned.bin');
    await writeFile(path, 'the quick brown fox');

    expect(await verifyFile(path, pin('the quick brown fox'))).toEqual({ ok: true });
  });

  it('reports a missing file as missing, not as corrupt', async () => {
    // The two need different advice — "fetch it" versus "it was tampered
    // with" — so the caller is told which happened rather than being handed a
    // single failure it has to guess about.
    const verdict = await verifyFile(join(await scratch(), 'absent'), pin('x'));

    expect(verdict).toMatchObject({ ok: false, missing: true });
    expect(verdict.ok === false && verdict.reason).toMatch(/is not in the cache/);
  });

  it('rejects a truncated file by its length, before hashing it', async () => {
    const dir = await scratch();
    const path = join(dir, 'pinned.bin');
    await writeFile(path, 'the quick brown');

    const verdict = await verifyFile(path, pin('the quick brown fox'));

    expect(verdict).toMatchObject({ ok: false, missing: false });
    // A half-written download is the common failure, and catching it by size
    // costs a stat rather than hashing 23 MB to learn the same thing.
    expect(verdict.ok === false && verdict.reason).toMatch(/truncated/);
  });

  it('rejects a file of the right length whose bytes were changed', async () => {
    const dir = await scratch();
    const path = join(dir, 'pinned.bin');
    await writeFile(path, 'the quick brown cat');

    const verdict = await verifyFile(path, pin('the quick brown fox'));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/has sha256 .* expected /);
  });
});
