/**
 * Where downloaded models live, and how their bytes are proved.
 *
 * ## Layout
 *
 * ```
 * <cache root>/agentfuse/models/<owner>--<model>/<revision>/<file>
 * ```
 *
 * The revision is a path segment rather than part of the file name so that
 * re-pinning a model in `models.ts` writes beside the old copy instead of
 * over it: a downgrade, a bisect or two checkouts of AgentFuse on one machine
 * all keep working, and nothing ever has to decide whether a file that is
 * present is the *right* file by looking at its name.
 *
 * The `/` in a Hugging Face id becomes `--`, which keeps one repo per directory
 * and — more to the point — means an id can never escape the cache root by
 * containing `..`. Only pinned ids reach this code (see `models.ts`), so this
 * is the second lock on a door that is already shut.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ModelFile, ModelSpec } from './models.js';

/** Environment this package reads. Injected so tests never touch the real one. */
export type Env = Readonly<Partial<Record<string, string>>>;

/**
 * The cache root, in precedence order.
 *
 * `AGENTFUSE_CACHE_DIR` exists for containers and CI, where the home directory
 * is often not the thing that survives between runs. `XDG_CACHE_HOME` is
 * honoured because ADR-003 says so and because a user who has moved their cache
 * has done it deliberately.
 */
export function cacheRoot(env: Env = process.env, override?: string | undefined): string {
  if (override !== undefined && override !== '') return override;
  const explicit = env.AGENTFUSE_CACHE_DIR;
  if (explicit !== undefined && explicit !== '') return explicit;
  const xdg = env.XDG_CACHE_HOME;
  if (xdg !== undefined && xdg !== '') return join(xdg, 'agentfuse');
  return join(homedir(), '.cache', 'agentfuse');
}

/** The directory holding one model revision's files. */
export function modelDir(root: string, spec: ModelSpec): string {
  return join(root, 'models', spec.id.replaceAll('/', '--'), spec.revision);
}

/** The path one file of a model is cached at. */
export function filePath(root: string, spec: ModelSpec, file: ModelFile): string {
  return join(modelDir(root, spec), file.name);
}

/** Streaming sha256 of a file, as lowercase hex. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  // Streamed rather than read whole: the model is 23 MB and this runs on the
  // path that starts a proxy, so there is no reason to hold it twice.
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Why a cached file was rejected. `'ok'` means it may be loaded. */
export type FileVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly missing: boolean };

/**
 * Checks one cached file against its pin.
 *
 * Size first, then digest: a truncated download is the common failure and
 * catching it by length costs a `stat` rather than hashing 23 MB to learn the
 * same thing. The digest still runs on every load, so a file that was corrupted
 * in place — a bad disk, a half-written copy, an editor that "fixed" the line
 * endings — is caught too, and is caught *before* the bytes reach the runtime.
 */
export async function verifyFile(path: string, file: ModelFile): Promise<FileVerdict> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { ok: false, missing: true, reason: `${path} is not in the cache` };
  }
  if (size !== file.bytes) {
    return {
      ok: false,
      missing: false,
      reason: `${path} is ${size} bytes, expected ${file.bytes} — the download is truncated or the file was modified`,
    };
  }
  const digest = await sha256File(path);
  if (digest !== file.sha256) {
    return {
      ok: false,
      missing: false,
      reason: `${path} has sha256 ${digest}, expected ${file.sha256}`,
    };
  }
  return { ok: true };
}
