/**
 * `installModel` — what `agentfuse models install` delegates to.
 *
 * The CLI owns the words and the exit code; this owns the bytes. It fetches
 * every pinned file of a model that is not already present and verified, and it
 * reports where they went and how much was written.
 *
 * A file that is present and matches its pin is left alone, which makes the
 * command idempotent and makes it a repair tool: a cache corrupted by a full
 * disk or an interrupted copy is detected by the same check that detects a bad
 * download, and re-running the install replaces exactly the broken file.
 */

import { cacheRoot, type Env, filePath, modelDir, verifyFile } from './cache.js';
import { type DownloadProgress, downloadFile, type FetchLike } from './download.js';
import { filesOf, type ModelSpec, modelSpec, urlOf } from './models.js';

/** Progress notes, matching the CLI's `InstallProgress` structurally. */
export type InstallProgress = DownloadProgress;

/** What {@link installModel} accepts. */
export interface InstallOptions {
  /** The model id, e.g. `Xenova/all-MiniLM-L6-v2`. */
  readonly model: string;
  readonly onProgress?: ((progress: InstallProgress) => void) | undefined;
  /** Overrides the cache root. Tests and containers; see `cacheRoot`. */
  readonly cacheDir?: string | undefined;
  readonly env?: Env | undefined;
  /** Injected so the download path is testable without a network. */
  readonly fetchImpl?: FetchLike | undefined;
}

/** Where a model ended up and how many bytes it occupies. */
export interface InstallResult {
  /** The directory holding the model's files. */
  readonly path: string;
  /** Total size of the installed files, downloaded or already present. */
  readonly bytes: number;
}

/**
 * Downloads a model into the cache, verifying every file against its pin.
 *
 * @throws {Error} for an unknown model id.
 * @throws {DownloadError} when downloads are off, the network fails, or the
 * bytes do not match the pin. Nothing partial is left behind.
 */
export async function installModel(options: InstallOptions): Promise<InstallResult> {
  const spec = modelSpec(options.model);
  const root = cacheRoot(options.env ?? process.env, options.cacheDir);
  const bytes = await ensureModelFiles(spec, root, { ...options, download: true });
  return { path: modelDir(root, spec), bytes };
}

/** How {@link ensureModelFiles} may reach the network, if at all. */
export interface EnsureOptions {
  readonly onProgress?: ((progress: InstallProgress) => void) | undefined;
  readonly env?: Env | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  /**
   * Whether a missing or failed file may be downloaded.
   *
   * `installModel` says yes; `createEmbeddingProvider` says no by default, so
   * that starting a proxy never silently turns into a 23 MB download in the
   * middle of somebody's agent run. The CLI's message for a missing model names
   * `agentfuse models install` for exactly this reason.
   */
  readonly download?: boolean | undefined;
}

/**
 * Makes every file of a model present and verified, returning the total size.
 *
 * The verification runs on every call, including when nothing is downloaded.
 * That is the point: the sha256 gate is a precondition of *loading*, not a
 * side effect of downloading, so a cache poisoned after the fact is caught.
 */
export async function ensureModelFiles(
  spec: ModelSpec,
  root: string,
  options: EnsureOptions,
): Promise<number> {
  let total = 0;
  for (const file of filesOf(spec)) {
    const path = filePath(root, spec, file);
    const verdict = await verifyFile(path, file);
    if (verdict.ok) {
      total += file.bytes;
      continue;
    }
    if (options.download !== true) {
      throw new Error(
        `${verdict.reason}. Run \`agentfuse models install --model ${spec.id}\` to fetch it.`,
      );
    }
    options.onProgress?.({ message: verdict.missing ? `fetching ${file.name}` : verdict.reason });
    total += await downloadFile({
      url: urlOf(spec, file),
      dest: path,
      file,
      ...(options.env !== undefined ? { env: options.env } : undefined),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : undefined),
      onProgress: options.onProgress,
    });
  }
  return total;
}
