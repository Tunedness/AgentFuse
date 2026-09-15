import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Two architectural rules of the CLI, enforced as tests rather than described
 * in a comment. `packages/core/src/purity.test.ts` and the proxy's
 * `boundary.test.ts` are the precedent: a rule that is only written down is a
 * rule that drifts.
 *
 * 1. **The CLI never depends on `@agentfuse/embeddings-local`.** ADR-003
 *    measured the reason — `onnxruntime-node` unpacks to about 301 MB because
 *    it ships every platform's binaries in one tarball, and a 300 MB
 *    `npx agentfuse` is not the frictionless drop-in this product is sold as.
 *    The companion package is found at runtime by a dynamic `import()` and
 *    declared in no manifest field.
 * 2. **Nothing writes to stdout except through the injected context.** In
 *    `wrap` mode this process's stdout *is* the agent's JSON-RPC stream, so a
 *    single `console.log` in a shared module corrupts every frame after it and
 *    the wrapped server gets blamed for AgentFuse's bug. `main.ts` is the one
 *    exception: it is the entry point, and it is where the real streams are
 *    bound to a {@link CliContext} once.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

/** The package that must never appear in the CLI's manifest. */
const EMBEDDINGS_PACKAGE = '@agentfuse/embeddings-local';

/** The only file allowed to touch the process's real streams. */
const ENTRY_POINT = 'main.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Strips comments, so prose that *names* a forbidden thing is not one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundleDependencies?: string[] | boolean;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as Manifest;
}

describe('the embeddings dependency direction', () => {
  it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const)(
    '%s does not name the companion package',
    (field) => {
      expect(Object.keys(manifest()[field] ?? {})).not.toContain(EMBEDDINGS_PACKAGE);
    },
  );

  it('declares nothing that could pull the ONNX runtime in transitively', () => {
    const declared = Object.keys({
      ...manifest().dependencies,
      ...manifest().devDependencies,
      ...manifest().peerDependencies,
      ...manifest().optionalDependencies,
    });

    // The CLI's dependency list is fixed by phase 1's dependency-direction
    // table. Anything new here is a decision, not a formality: this package is
    // what `npx agentfuse` downloads.
    expect(declared.sort()).toEqual([
      '@agentfuse/core',
      '@agentfuse/proxy',
      'gpt-tokenizer',
      'yaml',
    ]);
  });

  it('does not reference the companion package in a tsconfig project reference', () => {
    const tsconfig = readFileSync(
      fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
      'utf8',
    );

    // A project reference is a build-time dependency even when the manifest is
    // clean, and would make `tsc -b` in this package build the ONNX wrapper.
    expect(tsconfig).not.toContain('embeddings-local');
  });

  it('reaches the package only through a dynamic import of a runtime specifier', () => {
    const embeddings = stripComments(readFileSync(join(SRC, 'embeddings.ts'), 'utf8'));

    // A static `import … from '@agentfuse/embeddings-local'` would reintroduce
    // the dependency a bundler resolves eagerly, which is the whole thing the
    // design removes. The specifier is a constant so no static edge exists.
    expect(embeddings).not.toMatch(/from\s*['"]@agentfuse\/embeddings-local['"]/);
    expect(embeddings).toMatch(/import\(EMBEDDINGS_PACKAGE\)/);
  });

  it('never names the package statically anywhere else in the source', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => {
        const source = stripComments(readFileSync(file, 'utf8'));
        return new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"]${EMBEDDINGS_PACKAGE}`).test(
          source,
        );
      })
      .map((file) => file.slice(SRC.length));

    expect(offenders).toEqual([]);
  });
});

describe('stdout discipline', () => {
  it('no source file but the entry point reaches for console or process.stdout', () => {
    const banned = [/\bconsole\s*\./, /\bprocess\s*\.\s*stdout\b/, /\bprocess\s*\.\s*stderr\b/];
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const name = file.slice(SRC.length);
      if (name === ENTRY_POINT) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of banned) {
        if (pattern.test(source)) offenders.push(`${name}: ${pattern.source}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the entry point present, so the exception cannot become the rule', () => {
    expect(sourceFiles(SRC).map((file) => file.slice(SRC.length))).toContain(ENTRY_POINT);
  });

  it('no source file calls process.exit outside the entry point', () => {
    // A command returns an exit code; the entry point is what turns it into a
    // process exit. A library module that exits takes the whole wrap down with
    // whatever the agent had in flight.
    const offenders = sourceFiles(SRC)
      .filter((file) => file.slice(SRC.length) !== ENTRY_POINT)
      .filter((file) => /\bprocess\s*\.\s*exit\b/.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => file.slice(SRC.length));

    expect(offenders).toEqual([]);
  });
});
