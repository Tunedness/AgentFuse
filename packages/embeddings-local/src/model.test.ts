import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingProvider, ToolCallRecord } from '@agentfuse/core';
import { semanticEmbeddingText } from '@agentfuse/core';
import { afterAll, describe, expect, it } from 'vitest';
import { cacheRoot, filePath } from './cache.js';
import { createEmbeddingProvider } from './create.js';
import { installModel } from './install.js';
import { KNOWN_MODELS, type ModelSpec } from './models.js';

/**
 * The only tests in this package that need the real model, and the only one
 * that needs the network.
 *
 * **`npm test` needs neither.** The suite above this one covers the batching,
 * the pooling, the cache gate and the download logic against fakes; what is
 * left is the question no fake can answer — whether the vectors this package
 * produces actually mean anything — and that question costs 23 MB.
 *
 * - The embedding cases run when the model is already in the cache and skip
 *   otherwise, so a developer who has run `agentfuse models install` gets them
 *   for free and CI does not.
 * - The cold-download case runs only under `AGENTFUSE_TEST_DOWNLOAD=1`. It
 *   fetches into a temporary directory, so it proves a first-run install rather
 *   than a cache hit, and it is the only test in the repository that opens a
 *   socket to the internet.
 */

const SPEC = KNOWN_MODELS['Xenova/all-MiniLM-L6-v2'] as ModelSpec;

/** Whether the model is cached, checked cheaply enough to gate a `describe`. */
function cached(): boolean {
  const path = filePath(cacheRoot(), SPEC, SPEC.onnx);
  return existsSync(path) && statSync(path).size === SPEC.onnx.bytes;
}

/** A completed call, as the proxy records it and the detector embeds it. */
function record(
  server: string,
  tool: string,
  args: string,
  summary: string,
  isError = false,
): ToolCallRecord {
  return {
    id: `${tool}-${args}`,
    sessionId: 's',
    serverName: server,
    toolName: tool,
    args: {},
    argsNormalized: args,
    fingerprint: `${server}\0${tool}\0${args}`,
    startedAt: 0,
    outcome: { isError, resultSummary: summary, resultBytes: summary.length },
  };
}

/**
 * The fixtures go through `semanticEmbeddingText` rather than being written as
 * loose sentences: that function is a contract, phase 9 will calibrate against
 * the numbers below, and a measurement taken on a different text shape would
 * not be the measurement phase 9 inherits.
 */
const TEXTS = {
  searchPage1: semanticEmbeddingText(
    record('github', 'search_issues', '{"query":"login bug","page":1}', '3 issues found'),
  ),
  searchPage2: semanticEmbeddingText(
    record('github', 'search_issues', '{"query":"login bug","page":2}', '4 issues found'),
  ),
  searchReworded: semanticEmbeddingText(
    record('github', 'search_issues', '{"query":"login error","page":1}', '3 issues found'),
  ),
  writeFile: semanticEmbeddingText(
    record(
      'filesystem',
      'write_file',
      '{"content":"127.0.0.1 localhost","path":"/etc/hosts"}',
      'ok',
    ),
  ),
  sql: semanticEmbeddingText(
    record('postgres', 'query', '{"sql":"SELECT count(*) FROM orders"}', '42'),
  ),
  failingWrite: semanticEmbeddingText(
    record(
      'filesystem',
      'write_file',
      '{"content":"x","path":"/etc/hosts"}',
      'permission denied',
      true,
    ),
  ),
} as const;

function cosine(a: Float32Array, b: Float32Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += (a[i] as number) * (b[i] as number);
  return total;
}

function norm(vector: Float32Array): number {
  return Math.sqrt(cosine(vector, vector));
}

describe.runIf(cached())('the real model', () => {
  // Built on first use, not at collection time: a skipped `describe` still runs
  // its callback, and creating a provider there would load a model this run has
  // decided not to need.
  let opened: Promise<EmbeddingProvider> | undefined;
  const provider = (): Promise<EmbeddingProvider> => {
    opened ??= createEmbeddingProvider({ model: SPEC.id });
    return opened;
  };

  afterAll(async () => {
    if (opened !== undefined) await (await opened).close?.();
  });

  it('identifies itself the way a report will print it', async () => {
    const instance = await provider();
    expect(instance.id).toBe('local:all-MiniLM-L6-v2');
    expect(instance.dims).toBe(384);
  });

  it('returns unit vectors', async () => {
    const vectors = await (await provider()).embed(Object.values(TEXTS));

    for (const vector of vectors) {
      expect(vector).toHaveLength(384);
      // float32 accumulation over 384 terms; anything looser than this would
      // stop being a check on the normalisation.
      expect(norm(vector)).toBeCloseTo(1, 5);
    }
  });

  it('scores near-identical calls high and unrelated ones low', async () => {
    const [page1, page2, reworded, write, sql] = await (await provider()).embed([
      TEXTS.searchPage1,
      TEXTS.searchPage2,
      TEXTS.searchReworded,
      TEXTS.writeFile,
      TEXTS.sql,
    ]);

    // Measured at the time of writing: 0.9971 for the same search one page
    // along, 0.9791 for the same search reworded, against 0.117, 0.125 and
    // 0.066 for the unrelated pairs. Nearly an order of magnitude of daylight,
    // which is what a correct mean-pooling looks like and what a CLS-pooled or
    // unmasked one does not. The assertions sit well clear of both sides: this
    // is a sanity check that the recipe is right, not the ROC curve, which is
    // phase 9's job.
    expect(cosine(page1 as Float32Array, page2 as Float32Array)).toBeGreaterThan(0.9);
    expect(cosine(page1 as Float32Array, reworded as Float32Array)).toBeGreaterThan(0.9);
    expect(cosine(page1 as Float32Array, write as Float32Array)).toBeLessThan(0.5);
    expect(cosine(page1 as Float32Array, sql as Float32Array)).toBeLessThan(0.5);
    expect(cosine(write as Float32Array, sql as Float32Array)).toBeLessThan(0.5);
  });

  it('puts a failed call near the call that failed and not near everything else', async () => {
    const [ok, failed, sql] = await (await provider()).embed([
      TEXTS.writeFile,
      TEXTS.failingWrite,
      TEXTS.sql,
    ]);

    expect(cosine(ok as Float32Array, failed as Float32Array)).toBeGreaterThan(
      cosine(failed as Float32Array, sql as Float32Array),
    );
  });

  it('gives the same input the same vector', async () => {
    const instance = await provider();
    const first = await instance.embed([TEXTS.searchPage1, TEXTS.sql]);
    const second = await instance.embed([TEXTS.searchPage1, TEXTS.sql]);

    expect([...(first[0] as Float32Array)]).toEqual([...(second[0] as Float32Array)]);
    expect([...(first[1] as Float32Array)]).toEqual([...(second[1] as Float32Array)]);
  });

  it('gives a batched text essentially the vector it gets alone', async () => {
    const instance = await provider();
    const batched = await instance.embed(Object.values(TEXTS));
    const texts = Object.values(TEXTS);

    for (const [index, text] of texts.entries()) {
      const [alone] = await instance.embed([text]);
      // **Not exact, and it cannot be.** `model_quantized.onnx` is dynamically
      // quantised: the activation scale is derived from the whole input tensor,
      // so the neighbours a text is batched with move it slightly. Measured
      // worst case at the time of writing: 0.9983. That is the floor of what a
      // score on these vectors means, and phase 9 should not calibrate a
      // threshold to a resolution finer than it.
      expect(cosine(batched[index] as Float32Array, alone as Float32Array)).toBeGreaterThan(0.995);
    }
  });
});

describe.runIf(process.env.AGENTFUSE_TEST_DOWNLOAD === '1')('a cold download', () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it('fetches every pinned file and verifies it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentfuse-model-'));
    const messages: string[] = [];

    const result = await installModel({
      model: SPEC.id,
      cacheDir: dir,
      env: {},
      onProgress: (progress) => messages.push(progress.message),
    });

    expect(result.bytes).toBe(SPEC.onnx.bytes + SPEC.tokenizer.bytes + SPEC.tokenizerConfig.bytes);
    expect(messages).toContain('verified model_quantized.onnx');
    expect(existsSync(join(result.path, SPEC.onnx.name))).toBe(true);

    // Running it again must be a no-op: every file is present and verified, so
    // nothing is fetched and the command is safe to put in a setup script.
    const again = await installModel({ model: SPEC.id, cacheDir: dir, env: {} });
    expect(again).toEqual(result);
  }, 300_000);
});
