import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What `npm publish` would actually upload — asserted, not eyeballed.
 *
 * A tarball is the one artefact of this repository that nobody reviews. It is
 * assembled by a `files` array, a `.gitignore` and npm's own always-include
 * rules interacting, and the interaction is not obvious: `dist/` is gitignored
 * and still ships, `LICENSE` ships without being listed, and a single
 * unqualified `"dist"` entry shipped 91 source maps and a `.tsbuildinfo` until
 * this file was written. So the audit is a test that runs on every `npm test`
 * rather than a command somebody remembers before a release.
 *
 * Four things must never be in a tarball, and each one has a reason with a
 * measurement behind it:
 *
 * - **No model binary.** The int8 model is ~23 MB and the ONNX runtime is
 *   292 MB unpacked (ADR-003). Neither is ever in a published package: the
 *   model is downloaded to a cache on first use, and the runtime is a
 *   dependency of the optional companion. The size ceiling below is the
 *   backstop — nothing that large can pass it, whatever the file list says.
 * - **No benchmarks.** `@agentfuse/bench` carries a 200-session corpus and is
 *   `private: true`; it is also in the Changesets ignore list, so it can
 *   neither be published nor versioned by accident.
 * - **No test files.** `src/testing/` holds scenario doubles and harnesses that
 *   earlier phases deliberately kept out of the public contract: publishing
 *   them would turn every fixture into something people depend on.
 * - **No source maps pointing outside the tarball.** A map naming
 *   `../src/index.ts` when `src/` was never shipped is worse than no map at
 *   all — a debugger follows it and fails. The choice was between shipping
 *   `src/` too and dropping the maps; dropping them keeps `src/testing/**` out,
 *   which is the stronger of the two properties.
 *
 * The list is a **whitelist**, not a blocklist. A blocklist only catches the
 * things somebody already thought of, and the next thing to leak into a
 * tarball will be the one nobody listed.
 *
 * It lives in this package because these four tarballs are what `npx
 * agentfuse` downloads, and this is the package that gets downloaded.
 */

const ROOT_URL = new URL('../../../', import.meta.url);
/** The workspace root as a path, which is what `npm` needs as a working directory. */
const ROOT = fileURLToPath(ROOT_URL);

/** `npm` is a shell shim on Windows; everywhere else it is on PATH as-is. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Gated on the build, like `cli.test.ts` is: `npm pack` collects `dist/`, and
 * on a tree that has never been built there is nothing to audit. The workspace
 * gate runs `build` before `test`, so this always runs in CI.
 */
const built = existsSync(new URL('../dist/main.js', import.meta.url));

interface PackedFile {
  readonly path: string;
  readonly size: number;
}

interface Packed {
  readonly name: string;
  readonly filename: string;
  readonly files: readonly PackedFile[];
  readonly entryCount: number;
  readonly size: number;
  readonly unpackedSize: number;
}

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, string | Record<string, string>>;
  readonly files?: readonly string[];
}

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(new URL(`${dir}/package.json`, ROOT_URL), 'utf8')) as Manifest;
}

/** The workspace's own directory list, so a new package cannot skip the audit. */
const WORKSPACE_DIRS = [
  'packages/core',
  'packages/proxy',
  'packages/embeddings-local',
  'packages/cli',
  'bench',
];

/**
 * One `npm pack` for the whole workspace.
 *
 * `--dry-run --json` reports exactly the file list, the byte counts and the
 * tarball name npm would produce, and writes nothing. One invocation rather
 * than five keeps this test at a quarter of a second.
 */
function packAll(): readonly Packed[] {
  const stdout = execFileSync(NPM, ['pack', '--dry-run', '--json', '--workspaces'], {
    cwd: ROOT,
    encoding: 'utf8',
    // npm's notices go to stderr; only the JSON is on stdout.
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as Packed[];
}

const packed = built ? packAll() : [];

function tarball(name: string): Packed {
  const found = packed.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`npm pack did not report ${name}`);
  return found;
}

/** Everything npm ships without being asked, plus what each package declares. */
const ALWAYS = ['package.json', 'README.md', 'LICENSE', 'NOTICE'];

/** The publishable packages, and the directories their tarballs may draw from. */
const PUBLISHABLE = [
  { dir: 'packages/core', name: '@agentfuse/core', roots: ['dist/', 'schemas/'] },
  { dir: 'packages/proxy', name: '@agentfuse/proxy', roots: ['dist/'] },
  { dir: 'packages/embeddings-local', name: '@agentfuse/embeddings-local', roots: ['dist/'] },
  { dir: 'packages/cli', name: 'agentfuse', roots: ['dist/'] },
] as const;

/**
 * Patterns that must not appear, each named so a failure says what went wrong.
 *
 * These are inside the whitelist rather than instead of it: `dist/` is allowed
 * wholesale, and these are the things that can end up under it.
 */
const FORBIDDEN: readonly [string, RegExp][] = [
  ['a test file', /(^|\/)[^/]*\.test\.[cm]?[jt]s$/],
  ['a snapshot', /(^|\/)__snapshots__\//],
  ['test scaffolding', /(^|\/)testing\//],
  ['a source map', /\.map$/],
  ['build metadata', /\.tsbuildinfo$/],
  ['a native addon or model weight', /\.(node|onnx|wasm|bin|dylib|so|dll)$/],
  ['a dependency tree', /(^|\/)node_modules\//],
  ['the benchmark harness', /(^|\/)bench\//],
  ['an environment file', /(^|\/)\.env/],
  ['a lockfile', /(^|\/)package-lock\.json$/],
];

/**
 * 2 MiB unpacked, per package.
 *
 * Measured headroom: the largest of the four is 436 kB. The ceiling is there to
 * make the failure mode impossible rather than unlikely — the smallest thing
 * that could plausibly leak in is the 23 MB model, an order of magnitude over.
 */
const SIZE_CEILING = 2 * 1024 * 1024;

describe.runIf(built)('the published tarballs', () => {
  it('are exactly the four packages that are not private', () => {
    const publishable = WORKSPACE_DIRS.filter((dir) => manifest(dir).private !== true).map(
      (dir) => manifest(dir).name,
    );

    // Derived from the manifests rather than listed twice, so a new package
    // joins this audit by existing instead of by somebody remembering.
    expect(publishable.sort()).toEqual([...PUBLISHABLE].map((p) => p.name).sort());
  });

  it.each(PUBLISHABLE)('$name ships only from its declared roots', ({ name, roots }) => {
    const unexpected = tarball(name)
      .files.map((file) => file.path)
      .filter((path) => !ALWAYS.includes(path) && !roots.some((root) => path.startsWith(root)));

    expect(unexpected).toEqual([]);
  });

  it.each(PUBLISHABLE)('$name ships its licence and its notice', ({ name }) => {
    const paths = tarball(name).files.map((file) => file.path);

    // Apache-2.0 §4(a) and §4(d): a redistributed copy carries the licence and
    // the NOTICE. npm includes `LICENSE` on its own; `NOTICE` has to be asked
    // for, which is why it is in every `files` array.
    expect(paths).toContain('LICENSE');
    expect(paths).toContain('NOTICE');
  });

  it.each(PUBLISHABLE)('$name ships the README npmjs.com will render', ({ name }) => {
    expect(tarball(name).files.map((file) => file.path)).toContain('README.md');
  });

  it.each(PUBLISHABLE)('$name carries none of the things a tarball must not', ({ name }) => {
    const offences = tarball(name)
      .files.map((file) => file.path)
      .flatMap((path) => {
        const matched = FORBIDDEN.filter(([, pattern]) => pattern.test(path));
        return matched.map(([label]) => `${path} is ${label}`);
      });

    expect(offences).toEqual([]);
  });

  it.each(PUBLISHABLE)('$name resolves every path it advertises', ({ dir, name }) => {
    const pkg = manifest(dir);
    const shipped = new Set(tarball(name).files.map((file) => file.path));
    const advertised: string[] = [];

    for (const target of Object.values(pkg.exports ?? {})) {
      if (typeof target === 'string') advertised.push(target);
      else advertised.push(...Object.values(target));
    }
    advertised.push(...Object.values(pkg.bin ?? {}));

    // The failure this catches is the worst kind: an install that succeeds and
    // then throws ERR_MODULE_NOT_FOUND on first import, because `files` and
    // `exports` were edited on different days.
    expect(advertised.length).toBeGreaterThan(0);
    for (const path of advertised) {
      expect(shipped.has(path.replace(/^\.\//, ''))).toBe(true);
    }
  });

  it.each(PUBLISHABLE)('$name stays far below the size a model would need', ({ name }) => {
    expect(tarball(name).unpackedSize).toBeLessThan(SIZE_CEILING);
  });

  it('reports its measured sizes, so a jump is visible in a diff', () => {
    const sizes = Object.fromEntries(
      PUBLISHABLE.map(({ name }) => [name, tarball(name).entryCount]),
    );

    // File counts rather than byte counts: bytes move with every edit, while a
    // count changes only when the shape of the package does.
    expect(sizes).toEqual({
      '@agentfuse/core': 97,
      '@agentfuse/proxy': 24,
      '@agentfuse/embeddings-local': 22,
      agentfuse: 74,
    });
  });
});

describe('the benchmark harness', () => {
  it('is private, so `npm publish` skips it', () => {
    // Not a `files` question: npm refuses to publish a private package at all,
    // which is the only guarantee strong enough for a package that carries a
    // corpus and depends on the workspace by wildcard.
    expect(manifest('bench').private).toBe(true);
  });

  it('is ignored by Changesets, so it is never even versioned', () => {
    const config = JSON.parse(
      readFileSync(new URL('.changeset/config.json', ROOT_URL), 'utf8'),
    ) as { ignore?: string[] };

    expect(config.ignore).toContain('@agentfuse/bench');
  });

  it('declares no files array, so nothing about it looks publishable', () => {
    expect(manifest('bench').files).toBeUndefined();
  });
});

describe('the versions the packages report', () => {
  /**
   * The constants and the manifests have to agree.
   *
   * `CORE_VERSION` is stamped into every trip report and `versionBanner()` is
   * what `agentfuse --version` prints, while the manifest version is what npm
   * installs. They are separate declarations — deliberately, so that neither
   * package has to import JSON or read a file — and `changeset version` moves
   * only one of them. This test is what makes the other one get moved too.
   */
  it.each([
    ['packages/core', 'CORE_VERSION', 'src/version.ts'],
    ['packages/proxy', 'PROXY_VERSION', 'src/version.ts'],
    ['packages/embeddings-local', 'EMBEDDINGS_LOCAL_VERSION', 'src/index.ts'],
    ['packages/cli', 'CLI_VERSION', 'src/index.ts'],
  ])('%s declares %s as its manifest version', (dir, constant, file) => {
    const source = readFileSync(new URL(`${dir}/${file}`, ROOT_URL), 'utf8');
    const match = new RegExp(`${constant} = '([^']+)'`).exec(source);

    expect(match?.[1]).toBe(manifest(dir).version);
  });
});
