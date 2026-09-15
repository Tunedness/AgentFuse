/**
 * `createEmbeddingProvider` — the factory the CLI loads this package for.
 *
 * Its contract is fixed by `packages/cli/src/embeddings.ts`:
 *
 * ```ts
 * createEmbeddingProvider(options: { model: string }): Promise<EmbeddingProvider>
 * ```
 *
 * **It does not download.** A missing model is an error that names
 * `agentfuse models install`, not a 23 MB fetch started inside somebody's agent
 * run because they happened to start a proxy. `download: true` is available for
 * a caller that has decided otherwise; the CLI never passes it.
 *
 * Both heavy dependencies are imported dynamically, here and in `session.ts`,
 * so that the package's entry point stays cheap to import. The CLI imports it
 * merely to answer "is the backend installed", and `agentfuse models install`
 * imports it to download a model it cannot yet run.
 */

import type { EmbeddingProvider } from '@agentfuse/core';
import type { SpecialTokens } from './batch.js';
import { cacheRoot, type Env, filePath } from './cache.js';
import { ensureModelFiles } from './install.js';
import { type ModelSpec, modelSpec } from './models.js';
import { LocalEmbeddingProvider, type Tokenizing } from './provider.js';
import { openSession } from './session.js';

/** What {@link createEmbeddingProvider} accepts. */
export interface CreateOptions {
  /** The model id from `loop_detection.semantic.model`. */
  readonly model: string;
  /** Overrides the cache root. */
  readonly cacheDir?: string | undefined;
  readonly env?: Env | undefined;
  /** Intra-op threads for the runtime. Defaults to at most four. */
  readonly threads?: number | undefined;
  /** Allows a missing file to be downloaded. Off by default; see the module doc. */
  readonly download?: boolean | undefined;
}

/**
 * Loads a verified model and returns a provider over it.
 *
 * @throws {Error} for an unknown model id, a model that is not in the cache, or
 * a cached file whose sha256 does not match its pin.
 */
export async function createEmbeddingProvider(options: CreateOptions): Promise<EmbeddingProvider> {
  const spec = modelSpec(options.model);
  const env = options.env ?? process.env;
  const root = cacheRoot(env, options.cacheDir);

  await ensureModelFiles(spec, root, {
    env,
    ...(options.download !== undefined ? { download: options.download } : undefined),
  });

  const tokenizer = await loadTokenizer(spec, root);
  const session = await openSession(filePath(root, spec, spec.onnx), {
    ...(options.threads !== undefined ? { threads: options.threads } : undefined),
  });

  try {
    return new LocalEmbeddingProvider({
      spec,
      tokenizer: tokenizer.tokenizer,
      session,
      special: tokenizer.special,
    });
  } catch (error) {
    await session.close();
    throw error;
  }
}

/** A tokenizer plus the two special token ids the batch packer needs. */
interface LoadedTokenizer {
  readonly tokenizer: Tokenizing;
  readonly special: SpecialTokens;
}

/**
 * Builds the tokenizer from the two verified JSON files.
 *
 * `@huggingface/tokenizers` takes the parsed `tokenizer.json` and
 * `tokenizer_config.json` as objects — there is no loader that reads a
 * directory — which suits this package: the files have already been read once
 * to hash them, and nothing here should be resolving paths a model file asked
 * for.
 */
async function loadTokenizer(spec: ModelSpec, root: string): Promise<LoadedTokenizer> {
  const { readFile } = await import('node:fs/promises');
  const { Tokenizer } = await import('@huggingface/tokenizers');

  const [definition, config] = await Promise.all([
    readJson(readFile, filePath(root, spec, spec.tokenizer)),
    readJson(readFile, filePath(root, spec, spec.tokenizerConfig)),
  ]);

  const tokenizer = new Tokenizer(definition, config);
  const sep = tokenizer.token_to_id('[SEP]');
  const pad = tokenizer.token_to_id('[PAD]');
  if (sep === undefined || pad === undefined) {
    throw new Error(
      `${spec.tokenizer.name} for ${spec.id} defines no [SEP]/[PAD]; this package packs ` +
        'BERT-style batches and cannot truncate or pad without them',
    );
  }

  return { tokenizer: tokenizer as Tokenizing, special: { sep, pad } };
}

async function readJson(
  readFile: (path: string, encoding: 'utf8') => Promise<string>,
  path: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}
