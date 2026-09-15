import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DownloadError,
  type DownloadProgress,
  downloadFile,
  type FetchLike,
  isOffline,
  OFFLINE_ENV,
} from './download.js';
import type { ModelFile } from './models.js';

/**
 * The download is treated as a gate, so these tests are mostly about the ways
 * it must refuse. None of them opens a socket: `fetch` is injected.
 */

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentfuse-download-'));
  temporary.push(dir);
  return dir;
}

const CONTENT = 'the pinned bytes, and nothing else';

const PIN: ModelFile = {
  repoPath: 'onnx/pinned.bin',
  name: 'pinned.bin',
  sha256: createHash('sha256').update(CONTENT).digest('hex'),
  bytes: Buffer.byteLength(CONTENT),
};

/** A `fetch` that serves the given body in small chunks. */
function serving(body: string, options: { status?: number; chunk?: number } = {}): FetchLike {
  const status = options.status ?? 200;
  const chunk = options.chunk ?? 7;
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    body:
      status === 200
        ? (async function* () {
            const bytes = Buffer.from(body);
            for (let i = 0; i < bytes.length; i += chunk) {
              yield new Uint8Array(bytes.subarray(i, i + chunk));
            }
          })()
        : null,
  });
}

/** The error a call rejected with, so a test can read its message. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected the download to be refused');
    },
    (caught: unknown) => caught as Error,
  );
}

/** Any `.part` files left behind, which there must never be. */
async function leftovers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.part'));
}

describe('isOffline', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['yes', true],
    ['0', false],
    ['', false],
  ])('%s → %s', (value, expected) => {
    expect(isOffline({ [OFFLINE_ENV]: value })).toBe(expected);
  });

  it('is off when the variable is unset', () => {
    expect(isOffline({})).toBe(false);
  });
});

describe('downloadFile', () => {
  it('writes the file, verifies it, and leaves no temporary behind', async () => {
    const dir = await scratch();
    const dest = join(dir, 'pinned.bin');
    const progress: DownloadProgress[] = [];

    const written = await downloadFile({
      url: 'https://example.invalid/pinned.bin',
      dest,
      file: PIN,
      env: {},
      fetchImpl: serving(CONTENT),
      onProgress: (note) => progress.push(note),
    });

    expect(written).toBe(PIN.bytes);
    expect(await readFile(dest, 'utf8')).toBe(CONTENT);
    expect(await leftovers(dir)).toEqual([]);
    expect(progress.at(-1)?.message).toBe('verified pinned.bin');
  });

  it('creates the destination directory', async () => {
    const dir = await scratch();
    const dest = join(dir, 'models', 'owner--model', 'rev', 'pinned.bin');

    await downloadFile({
      url: 'https://example.invalid/pinned.bin',
      dest,
      file: PIN,
      env: {},
      fetchImpl: serving(CONTENT),
    });

    expect(existsSync(dest)).toBe(true);
  });

  it('refuses before opening a socket when AGENTFUSE_OFFLINE is set', async () => {
    const dir = await scratch();
    let called = false;

    const error = await rejection(
      downloadFile({
        url: 'https://example.invalid/pinned.bin',
        dest: join(dir, 'pinned.bin'),
        file: PIN,
        env: { [OFFLINE_ENV]: '1' },
        fetchImpl: async () => {
          called = true;
          throw new Error('unreachable');
        },
      }),
    );

    expect(called).toBe(false);
    expect(error).toBeInstanceOf(DownloadError);
    expect((error as DownloadError).offline).toBe(true);
    // The failure mode this prevents is the obscure one: a tool that "works
    // offline" by hanging on a DNS lookup. The message names the variable and
    // the path it wanted.
    expect((error as DownloadError).message).toContain(OFFLINE_ENV);
    expect((error as DownloadError).message).toContain(join(dir, 'pinned.bin'));
    expect(await leftovers(dir)).toEqual([]);
  });

  it('reports a non-2xx response and installs nothing', async () => {
    const dir = await scratch();
    const dest = join(dir, 'pinned.bin');

    await expect(
      downloadFile({
        url: 'https://example.invalid/pinned.bin',
        dest,
        file: PIN,
        env: {},
        fetchImpl: serving('', { status: 404 }),
      }),
    ).rejects.toThrow(/HTTP 404/);

    expect(existsSync(dest)).toBe(false);
    expect(await leftovers(dir)).toEqual([]);
  });

  it('reports a response with no body', async () => {
    const dir = await scratch();

    await expect(
      downloadFile({
        url: 'https://example.invalid/pinned.bin',
        dest: join(dir, 'pinned.bin'),
        file: PIN,
        env: {},
        fetchImpl: async () => ({ ok: true, status: 200, statusText: 'OK', body: null }),
      }),
    ).rejects.toThrow(/no body/);
  });

  it('aborts a response that runs past the pinned size', async () => {
    const dir = await scratch();
    const dest = join(dir, 'pinned.bin');
    let aborted = false;

    const fetchImpl: FetchLike = async (_url, init) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
      });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: (async function* () {
          // Ten times the pin. Nothing is buffered in memory and the stream is
          // cut as soon as the cap is passed, so an endless body cannot fill
          // the disk either.
          for (let i = 0; i < 10; i += 1) yield new Uint8Array(Buffer.from(CONTENT));
        })(),
      };
    };

    await expect(
      downloadFile({ url: 'https://example.invalid/x', dest, file: PIN, env: {}, fetchImpl }),
    ).rejects.toThrow(/larger than the pinned/);

    expect(aborted).toBe(true);
    expect(existsSync(dest)).toBe(false);
    expect(await leftovers(dir)).toEqual([]);
  });

  it('rejects a truncated response rather than installing a short file', async () => {
    const dir = await scratch();
    const dest = join(dir, 'pinned.bin');

    await expect(
      downloadFile({
        url: 'https://example.invalid/x',
        dest,
        file: PIN,
        env: {},
        fetchImpl: serving(CONTENT.slice(0, 10)),
      }),
    ).rejects.toThrow(/truncated/);

    // The point of the atomic rename: a half-finished download is never in a
    // place anything would look for a complete one.
    expect(existsSync(dest)).toBe(false);
    expect(await leftovers(dir)).toEqual([]);
  });

  it('rejects a full-length response whose digest is wrong, naming both', async () => {
    const dir = await scratch();
    const dest = join(dir, 'pinned.bin');
    const corrupted = `${CONTENT.slice(0, -1)}!`;

    const error = await rejection(
      downloadFile({
        url: 'https://example.invalid/x',
        dest,
        file: PIN,
        env: {},
        fetchImpl: serving(corrupted),
      }),
    );

    expect(error.message).toContain(PIN.sha256);
    expect(error.message).toContain(createHash('sha256').update(corrupted).digest('hex'));
    // There is no "try it anyway" path. Bytes we cannot account for do not
    // reach the inference runtime.
    expect(error.message).toContain('not loaded');
    expect(existsSync(dest)).toBe(false);
    expect(await leftovers(dir)).toEqual([]);
  });

  it('overwrites a file that is already there', async () => {
    const dir = await scratch();
    const dest = join(dir, 'pinned.bin');
    await writeFile(dest, 'stale');

    await downloadFile({
      url: 'https://example.invalid/x',
      dest,
      file: PIN,
      env: {},
      fetchImpl: serving(CONTENT),
    });

    expect(await readFile(dest, 'utf8')).toBe(CONTENT);
  });

  it('survives two processes downloading the same file at once', async () => {
    const dir = await scratch();
    const dest = join(dir, 'pinned.bin');

    // Each writes its own randomly named temporary in the destination
    // directory and renames it over the result. Both renames are atomic, so a
    // reader sees either nothing or a complete file — never the interleaving a
    // shared `createWriteStream(dest)` would produce, which no digest check on
    // *load* could tell apart from a bad network.
    await Promise.all(
      [0, 1, 2].map(() =>
        downloadFile({
          url: 'https://example.invalid/x',
          dest,
          file: PIN,
          env: {},
          fetchImpl: serving(CONTENT, { chunk: 3 }),
        }),
      ),
    );

    expect(await readFile(dest, 'utf8')).toBe(CONTENT);
    expect(await leftovers(dir)).toEqual([]);
  });

  it('reports progress against the pinned total', async () => {
    const dir = await scratch();
    const big = 'x'.repeat(2_000_000);
    const file: ModelFile = {
      repoPath: 'big.bin',
      name: 'big.bin',
      sha256: createHash('sha256').update(big).digest('hex'),
      bytes: big.length,
    };
    const progress: DownloadProgress[] = [];

    await downloadFile({
      url: 'https://example.invalid/big.bin',
      dest: join(dir, 'big.bin'),
      file,
      env: {},
      fetchImpl: serving(big, { chunk: 64 * 1024 }),
      onProgress: (note) => progress.push(note),
    });

    expect(progress.length).toBeGreaterThan(2);
    expect(progress.every((note) => note.total === file.bytes)).toBe(true);
    expect(progress.at(-1)?.received).toBe(file.bytes);
  });
});
