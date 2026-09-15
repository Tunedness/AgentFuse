import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The purity invariant, enforced.
 *
 * `@agentfuse/core` must stay free of I/O and free of protocol. That is what
 * lets the proxy, the CLI, an in-process SDK and (later) McpGuard all reuse the
 * same engine, and what makes every decision reproducible under a fake clock.
 *
 * Documentation does not enforce an invariant; a failing test does.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

/**
 * `node:crypto` is the single permitted builtin: SHA-256 is computation, not
 * I/O. Everything else on this list either touches the outside world or drags
 * a protocol into a package that must not know about one.
 */
const FORBIDDEN = [
  '@modelcontextprotocol',
  '@agentfuse/embeddings-local',
  '@agentfuse/proxy',
  '@agentfuse/cli',
  'node:fs',
  'node:net',
  'node:child_process',
  'node:http',
  'node:https',
  'node:dns',
  'node:tls',
  'node:dgram',
  'node:worker_threads',
  'node:os',
  'node:process',
  'node:readline',
  'node:cluster',
  'node:v8',
  'node:vm',
  'node:inspector',
];

/** `import x from 'y'`, `export … from 'y'`, `import('y')`, `require('y')`. */
const SPECIFIER_RE =
  /(?:\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gm;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Strips comments, so a doc comment that *names* a forbidden call is not
 * mistaken for one. The rules below are about code, and every one of these
 * modules explains in prose exactly what it refuses to do.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SPECIFIER_RE)) {
    const specifier = match[1];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

describe('purity invariant', () => {
  const files = sourceFiles(SRC);

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((file) => [file.slice(SRC.length), file] as const))(
    'src/%s imports nothing that does I/O',
    (_label, file) => {
      const offenders = specifiers(stripComments(readFileSync(file, 'utf8'))).filter((specifier) =>
        FORBIDDEN.some((banned) => specifier === banned || specifier.startsWith(`${banned}/`)),
      );
      expect(offenders).toEqual([]);
    },
  );

  it('imports only node:crypto from the Node builtins', () => {
    const builtins = new Set<string>();
    for (const file of files) {
      for (const specifier of specifiers(stripComments(readFileSync(file, 'utf8')))) {
        if (specifier.startsWith('node:')) builtins.add(specifier);
      }
    }
    expect([...builtins]).toEqual(['node:crypto']);
  });

  it('declares zod as its only runtime dependency', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['zod']);
  });

  it('never reads the wall clock or the global RNG outside its adapters', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith('adapters/clock.ts') || file.endsWith('adapters/ulid.ts')) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      if (/\bDate\.now\s*\(/.test(source)) offenders.push(`${file}: Date.now()`);
      if (/\bMath\.random\s*\(/.test(source)) offenders.push(`${file}: Math.random()`);
    }
    expect(offenders).toEqual([]);
  });
});
