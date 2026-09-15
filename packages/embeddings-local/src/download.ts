/**
 * Fetching a pinned file into the cache, treating the response as hostile.
 *
 * The bytes on the other end of this request are about to be handed to a native
 * inference runtime, so this module is written as a gate rather than as a
 * download helper. In order:
 *
 * 1. **Offline is a wall, not a hint.** `AGENTFUSE_OFFLINE=1` refuses before
 *    any socket is opened, with a message that names the variable and the path
 *    it was looking for. The failure mode this prevents is the obscure one —
 *    a tool that "works offline" by hanging on a DNS lookup for thirty seconds.
 * 2. **The size is capped by the pin.** The expected byte count is the cap, so a
 *    response that keeps going is aborted mid-stream. Nothing is buffered in
 *    memory: the body is streamed to disk as it arrives.
 * 3. **The temp file is in the destination directory** and carries a random
 *    suffix. Same directory means `rename` is atomic on the same filesystem;
 *    random suffix means two processes downloading the same model at the same
 *    time write to different files and each renames a complete one over the
 *    other. A reader therefore sees either no file or a whole file — never a
 *    half-written one, which is the corruption a naive `createWriteStream(dest)`
 *    produces and which no digest check on *load* can distinguish from a bad
 *    network.
 * 4. **The digest is checked before the rename.** A mismatch deletes the temp
 *    file and throws, naming both digests. There is no "try it anyway" path: a
 *    graph whose bytes we cannot account for is exactly what the pin exists to
 *    keep out of the runtime.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Env } from './cache.js';
import type { ModelFile } from './models.js';

/** The subset of `fetch` this module uses. Injected so tests need no network. */
export type FetchLike = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly body: AsyncIterable<Uint8Array> | null;
}>;

/** A note worth printing while a download runs. */
export interface DownloadProgress {
  readonly message: string;
  readonly received?: number;
  readonly total?: number;
}

/** What {@link downloadFile} needs. */
export interface DownloadOptions {
  readonly url: string;
  readonly dest: string;
  readonly file: ModelFile;
  readonly env?: Env;
  readonly fetchImpl?: FetchLike;
  readonly onProgress?: ((progress: DownloadProgress) => void) | undefined;
}

/** The environment variable that turns every download off. */
export const OFFLINE_ENV = 'AGENTFUSE_OFFLINE';

/** Whether downloads are disabled. Any non-empty value other than `0` counts. */
export function isOffline(env: Env = process.env): boolean {
  const value = env[OFFLINE_ENV];
  return value !== undefined && value !== '' && value !== '0';
}

/** Raised when a download is refused or its bytes did not match the pin. */
export class DownloadError extends Error {
  /** True when nothing was attempted because {@link OFFLINE_ENV} is set. */
  readonly offline: boolean;

  constructor(message: string, options?: { offline?: boolean; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DownloadError';
    this.offline = options?.offline ?? false;
  }
}

/** How often progress is reported, in bytes. Roughly forty lines for a model. */
const PROGRESS_STRIDE = 512 * 1024;

/**
 * Downloads one pinned file to {@link DownloadOptions.dest}.
 *
 * Returns the number of bytes written, which is always `file.bytes` — it is
 * returned rather than assumed so a caller totalling a multi-file install does
 * not have to trust two copies of the same number.
 *
 * @throws {DownloadError} for an offline refusal, a non-2xx response, a size
 * that does not match the pin, or a digest that does not match the pin.
 */
export async function downloadFile(options: DownloadOptions): Promise<number> {
  const { url, dest, file } = options;
  const env = options.env ?? process.env;

  if (isOffline(env)) {
    throw new DownloadError(
      `${OFFLINE_ENV} is set, so ${file.name} was not downloaded. ` +
        `Unset it to allow the download, or place a verified copy at ${dest}.`,
      { offline: true },
    );
  }

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  await mkdir(dirname(dest), { recursive: true });

  const temp = `${dest}.${randomBytes(6).toString('hex')}.part`;
  const controller = new AbortController();
  const hash = createHash('sha256');
  let received = 0;

  const handle = await open(temp, 'wx');
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new DownloadError(
        `fetching ${url} failed with HTTP ${response.status} ${response.statusText}`,
      );
    }
    if (response.body === null) {
      throw new DownloadError(`fetching ${url} returned no body`);
    }

    options.onProgress?.({ message: `downloading ${file.name}`, received: 0, total: file.bytes });
    let reported = 0;
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > file.bytes) {
        // Abort rather than read to the end: the pin says how big this file is,
        // so a longer response is already wrong and there is no reason to pay
        // for the rest of it.
        controller.abort();
        throw new DownloadError(
          `${url} is larger than the pinned ${file.bytes} bytes; aborted after ${received}`,
        );
      }
      hash.update(chunk);
      await handle.write(chunk);
      if (received - reported >= PROGRESS_STRIDE) {
        reported = received;
        options.onProgress?.({ message: `downloading ${file.name}`, received, total: file.bytes });
      }
    }

    if (received !== file.bytes) {
      throw new DownloadError(
        `${url} delivered ${received} bytes, expected ${file.bytes} — the download is truncated`,
      );
    }
    const digest = hash.digest('hex');
    if (digest !== file.sha256) {
      throw new DownloadError(
        `${url} has sha256 ${digest}, expected ${file.sha256}. ` +
          'The file was not installed. This is either corruption in transit or a different ' +
          'artefact than the one this build pins; either way it is not loaded.',
      );
    }

    await handle.close();
    // Atomic on the same filesystem, which the temp file is guaranteed to be on
    // because it was created in the destination directory.
    await rename(temp, dest);
    options.onProgress?.({ message: `verified ${file.name}`, received, total: file.bytes });
    return received;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true });
    throw error;
  }
}
