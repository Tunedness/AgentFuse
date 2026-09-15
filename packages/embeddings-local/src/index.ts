/**
 * Local, on-device embedding backend for AgentFuse semantic loop detection.
 *
 * ## Why this is a separate package
 *
 * ADR-003 measured it: `onnxruntime-node` unpacks to about 301 MB, because it
 * ships every platform's binaries in one tarball with no per-platform
 * `optionalDependencies` to split them. A `npx agentfuse` that dragged that in
 * would not be the frictionless drop-in this product is sold as. So the runtime
 * lives here, and **nothing depends on this package**: `agentfuse` finds it at
 * run time through `await import('@agentfuse/embeddings-local')` and does
 * without it when it is not there. `discipline.test.ts` fails the build if any
 * manifest in the workspace ever names it.
 *
 * Umbrella ADR-001 forbids crippleware, which is why "does without it" has to
 * mean something: the deterministic loop rules — exact repeats, error repeats,
 * short cycles — are fully functional on a plain install. This package adds the
 * semantic tier on top.
 *
 * ## What the CLI loads it for
 *
 * Two exports, and their shapes are fixed by `packages/cli/src/embeddings.ts`:
 *
 * ```ts
 * createEmbeddingProvider(options: { model: string }): Promise<EmbeddingProvider>
 * installModel(options: { model: string; onProgress?: (p) => void })
 *   : Promise<{ path: string; bytes: number }>
 * ```
 *
 * `EmbeddingProvider` is `@agentfuse/core`'s frozen port. Its vectors are
 * L2-normalised — not as a nicety but because phase 3's window score,
 * `(‖S‖² − W) / (W · (W − 1))`, is the mean pairwise cosine only for unit
 * vectors and is quietly meaningless otherwise.
 *
 * ## What it costs to import
 *
 * Nothing much. Every heavy dependency is behind a dynamic import inside the
 * function that needs it, so importing this module — which the CLI does just to
 * find out whether the backend exists — loads no native code and no model.
 */

export type { EncodedBatch, Encoding, SpecialTokens } from './batch.js';
export { meanPool, packBatch } from './batch.js';
export type { Env, FileVerdict } from './cache.js';
export { cacheRoot, filePath, modelDir, sha256File, verifyFile } from './cache.js';
export type { CreateOptions } from './create.js';
export { createEmbeddingProvider } from './create.js';
export type { DownloadProgress, FetchLike } from './download.js';
export { DownloadError, downloadFile, isOffline, OFFLINE_ENV } from './download.js';
export type { EnsureOptions, InstallOptions, InstallProgress, InstallResult } from './install.js';
export { ensureModelFiles, installModel } from './install.js';
export type { ModelFile, ModelSpec } from './models.js';
export { DEFAULT_MODEL, KNOWN_MODELS, modelSpec, urlOf } from './models.js';
export type { ProviderParts, Tokenizing } from './provider.js';
export { LocalEmbeddingProvider } from './provider.js';
export type { EmbeddingSession, SessionOptions } from './session.js';
export { defaultThreads, openSession } from './session.js';

/**
 * The value of `loop_detection.semantic.provider` that selects this backend.
 *
 * Named here rather than in the CLI's schema so the two cannot drift apart in
 * the only direction that matters: a policy that says `local` and a package
 * that answers to something else.
 */
export const BACKEND_ID = 'local';

/** Version of this package's contract, for reports and diagnostics. */
export const EMBEDDINGS_LOCAL_VERSION = '0.0.0';
