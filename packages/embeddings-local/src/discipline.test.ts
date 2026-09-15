import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The architectural rules of this package, enforced as tests.
 * `packages/core/src/purity.test.ts`, the proxy's `boundary.test.ts` and the
 * CLI's `discipline.test.ts` are the precedent: a rule that is only written
 * down is a rule that drifts.
 *
 * 1. **Nothing may depend on this package.** The CLI pins the same rule from
 *    its own side; this pins it for the whole workspace, including packages
 *    that do not exist yet. ADR-003 measured the reason — `onnxruntime-node`
 *    unpacks to about 301 MB because it ships every platform's binaries in one
 *    tarball — and the answer was a companion package found at run time by
 *    dynamic `import()` and declared nowhere.
 * 2. **Only `session.ts` touches the ONNX runtime.** Everything else has to
 *    stay runnable, and testable, without it. That is what lets the batching,
 *    the pooling, the cache gate and the download logic be covered by a suite
 *    that loads no native code.
 * 3. **Nothing writes to stdout.** This package is loaded inside
 *    `agentfuse wrap`, where this process's stdout *is* the agent's JSON-RPC
 *    stream, and one stray `console.log` corrupts every frame after it.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));
const WORKSPACE = fileURLToPath(new URL('../../..', import.meta.url));
const SELF = '@agentfuse/embeddings-local';

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function read(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/** Every manifest in the workspace: the root, every package, and `bench`. */
function manifests(): [string, Manifest][] {
  const out: [string, Manifest][] = [['package.json', read(join(WORKSPACE, 'package.json'))]];
  for (const dir of ['packages', '.']) {
    const base = join(WORKSPACE, dir);
    for (const name of readdirSync(base, { withFileTypes: true })) {
      if (!name.isDirectory() || name.name === 'node_modules') continue;
      const path = join(dir, name.name, 'package.json');
      try {
        out.push([path, read(join(WORKSPACE, path))]);
      } catch {
        // Not every directory is a workspace member.
      }
    }
  }
  return out;
}

function declared(manifest: Manifest): string[] {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  });
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'testing') out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strips comments, so prose that *names* a forbidden thing is not one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the dependency direction', () => {
  it('is declared by no manifest in the workspace, including this one', () => {
    for (const [path, manifest] of manifests()) {
      expect(declared(manifest), path).not.toContain(SELF);
    }
  });

  it('is referenced by no other package`s tsconfig', () => {
    // A project reference is a build-time dependency even when the manifest is
    // clean, and would make `tsc -b` in that package build the ONNX wrapper.
    for (const name of readdirSync(join(WORKSPACE, 'packages'))) {
      if (name === 'embeddings-local') continue;
      const tsconfig = readFileSync(join(WORKSPACE, 'packages', name, 'tsconfig.json'), 'utf8');
      expect(tsconfig, name).not.toContain('embeddings-local');
    }
  });

  it('is imported statically by no source file outside this package', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(join(WORKSPACE, 'packages'))) {
      if (name === 'embeddings-local') continue;
      const root = join(WORKSPACE, 'packages', name, 'src');
      for (const file of sourceFiles(root)) {
        const source = stripComments(readFileSync(file, 'utf8'));
        // Naming the package in a string is fine and necessary — the CLI's
        // message tells people to install it. What must not exist is an edge a
        // resolver or a bundler follows, so the pattern is the import forms
        // rather than the name. The sanctioned dynamic form goes through a
        // constant and matches nothing here.
        if (new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"]${SELF}`).test(source)) {
          offenders.push(file.slice(WORKSPACE.length));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares exactly the three dependencies ADR-003 chose', () => {
    const self = read(join(WORKSPACE, 'packages', 'embeddings-local', 'package.json'));

    // `@huggingface/transformers` was rejected for dragging `sharp` in and
    // pinning an old runtime; `fastembed` for being unmaintained and pinned to
    // ORT 1.21. Anything new in this list is a decision, not a formality.
    expect(declared(self).sort()).toEqual([
      '@agentfuse/core',
      '@huggingface/tokenizers',
      'onnxruntime-node',
    ]);
  });
});

describe('the runtime boundary', () => {
  it('is crossed by session.ts and nothing else', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => stripComments(readFileSync(file, 'utf8')).includes('onnxruntime-node'))
      .map((file) => file.slice(SRC.length));

    expect(offenders).toEqual(['session.ts']);
  });

  it('keeps the tokenizer in one file too', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) =>
        stripComments(readFileSync(file, 'utf8')).includes('@huggingface/tokenizers'),
      )
      .map((file) => file.slice(SRC.length));

    expect(offenders).toEqual(['create.ts']);
  });

  it('loads both of them dynamically, so importing this package stays cheap', () => {
    // The CLI imports the entry point merely to find out whether the backend is
    // installed, and `agentfuse models install` imports it to download a model
    // it cannot yet run. Neither should pay for dlopen-ing a native addon.
    for (const [file, specifier] of [
      ['session.ts', 'onnxruntime-node'],
      ['create.ts', '@huggingface/tokenizers'],
    ]) {
      const source = stripComments(readFileSync(join(SRC, file as string), 'utf8'));
      expect(source, file).not.toMatch(new RegExp(`from\\s*['"]${specifier}['"]`));
      expect(source, file).toMatch(new RegExp(`import\\(['"]${specifier}['"]\\)`));
    }
  });
});

describe('stdout discipline', () => {
  it('is observed by every source file', () => {
    const banned = [/\bconsole\s*\./, /\bprocess\s*\.\s*stdout\b/, /\bprocess\s*\.\s*stderr\b/];
    const offenders = sourceFiles(SRC).filter((file) => {
      const source = stripComments(readFileSync(file, 'utf8'));
      return banned.some((pattern) => pattern.test(source));
    });

    expect(offenders.map((file) => file.slice(SRC.length))).toEqual([]);
  });
});
