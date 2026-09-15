import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { filePath, modelDir } from './cache.js';
import { DownloadError, type FetchLike, OFFLINE_ENV } from './download.js';
import { ensureModelFiles, type InstallProgress, installModel } from './install.js';
import { filesOf, KNOWN_MODELS, type ModelSpec, urlOf } from './models.js';

const SPEC = KNOWN_MODELS['Xenova/all-MiniLM-L6-v2'] as ModelSpec;

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentfuse-install-'));
  temporary.push(dir);
  return dir;
}

/**
 * A `fetch` that serves bodies the pins were computed from.
 *
 * The real files are 23 MB and their digests are fixed constants, so the test
 * cannot fabricate their content. Instead the spec under test is a copy of the
 * real one with the digests recomputed over short strings — which exercises
 * every line of the install path and keeps the suite instant.
 */
function fixture(): { spec: ModelSpec; bodies: Map<string, string>; fetchImpl: FetchLike } {
  const bodies = new Map<string, string>();
  const spec = withBodies(SPEC, bodies);
  const fetchImpl: FetchLike = async (url) => {
    const body = bodies.get(url);
    if (body === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found', body: null };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: (async function* () {
        yield new Uint8Array(Buffer.from(body));
      })(),
    };
  };
  return { spec, bodies, fetchImpl };
}

function withBodies(spec: ModelSpec, bodies: Map<string, string>): ModelSpec {
  const rewrite = (file: ModelSpec['onnx'], body: string): ModelSpec['onnx'] => {
    bodies.set(urlOf(spec, file), body);
    return {
      ...file,
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: Buffer.byteLength(body),
    };
  };
  return {
    ...spec,
    onnx: rewrite(spec.onnx, 'pretend this is an onnx graph'),
    tokenizer: rewrite(spec.tokenizer, '{"model":{}}'),
    tokenizerConfig: rewrite(spec.tokenizerConfig, '{"clean_up_tokenization_spaces":true}'),
  };
}

describe('installModel', () => {
  it('refuses a model it has no pinned digest for, and says which it knows', async () => {
    // Accepting an arbitrary id would mean loading a graph whose bytes cannot
    // be checked, which is the one thing the pin table exists to prevent. The
    // realistic cause is a typo in a policy file, so the message lists what is
    // available.
    await expect(installModel({ model: 'sentence-transformers/whatever' })).rejects.toThrow(
      /unknown embedding model .*this build pins Xenova\/all-MiniLM-L6-v2/s,
    );
  });

  it('propagates the offline refusal', async () => {
    await expect(
      installModel({ model: SPEC.id, cacheDir: await scratch(), env: { [OFFLINE_ENV]: '1' } }),
    ).rejects.toBeInstanceOf(DownloadError);
  });
});

describe('ensureModelFiles', () => {
  it('fetches every pinned file and totals their sizes', async () => {
    const root = await scratch();
    const { spec, fetchImpl } = fixture();
    const progress: InstallProgress[] = [];

    const bytes = await ensureModelFiles(spec, root, {
      download: true,
      env: {},
      fetchImpl,
      onProgress: (note) => progress.push(note),
    });

    expect(bytes).toBe(spec.onnx.bytes + spec.tokenizer.bytes + spec.tokenizerConfig.bytes);
    for (const file of filesOf(spec)) {
      expect(existsSync(filePath(root, spec, file))).toBe(true);
    }
    expect(progress.map((note) => note.message)).toContain('verified model_quantized.onnx');
  });

  it('fetches the tokenizer before the model', async () => {
    const root = await scratch();
    const { spec, fetchImpl } = fixture();
    const order: string[] = [];

    await ensureModelFiles(spec, root, {
      download: true,
      env: {},
      fetchImpl,
      onProgress: (note) => order.push(note.message),
    });

    // A bad proxy or a 403 costs a second rather than 23 MB.
    const model = order.indexOf('fetching model_quantized.onnx');
    expect(order.indexOf('fetching tokenizer.json')).toBeLessThan(model);
  });

  it('downloads nothing when every file is present and verified', async () => {
    const root = await scratch();
    const { spec, fetchImpl } = fixture();
    await ensureModelFiles(spec, root, { download: true, env: {}, fetchImpl });

    let refetched = false;
    const bytes = await ensureModelFiles(spec, root, {
      download: true,
      env: {},
      fetchImpl: async (...args) => {
        refetched = true;
        return fetchImpl(...args);
      },
    });

    // Idempotent, so the command is safe in a setup script.
    expect(refetched).toBe(false);
    expect(bytes).toBe(spec.onnx.bytes + spec.tokenizer.bytes + spec.tokenizerConfig.bytes);
  });

  it('repairs exactly the file that was corrupted', async () => {
    const root = await scratch();
    const { spec, fetchImpl } = fixture();
    await ensureModelFiles(spec, root, { download: true, env: {}, fetchImpl });

    const damaged = filePath(root, spec, spec.tokenizer);
    await writeFile(damaged, 'x'.repeat(spec.tokenizer.bytes));
    const requested: string[] = [];

    await ensureModelFiles(spec, root, {
      download: true,
      env: {},
      fetchImpl: async (url, init) => {
        requested.push(url);
        return fetchImpl(url, init);
      },
    });

    // The same check that catches a bad download catches a cache damaged after
    // the fact, which makes the install command a repair tool.
    expect(requested).toEqual([urlOf(spec, spec.tokenizer)]);
    expect(await readFile(damaged, 'utf8')).toBe('{"model":{}}');
  });

  it('refuses to download when the caller did not ask it to', async () => {
    const root = await scratch();
    const { spec } = fixture();

    // This is the path `createEmbeddingProvider` takes: starting a proxy must
    // never turn into a 23 MB fetch in the middle of an agent run.
    await expect(ensureModelFiles(spec, root, { env: {} })).rejects.toThrow(
      /agentfuse models install --model Xenova\/all-MiniLM-L6-v2/,
    );
  });

  it('refuses a cached file whose digest is wrong, even with downloads off', async () => {
    const root = await scratch();
    const { spec } = fixture();
    await mkdir(modelDir(root, spec), { recursive: true });
    await writeFile(
      filePath(root, spec, spec.tokenizerConfig),
      'x'.repeat(spec.tokenizerConfig.bytes),
    );

    await expect(ensureModelFiles(spec, root, { env: {} })).rejects.toThrow(/has sha256/);
  });
});
