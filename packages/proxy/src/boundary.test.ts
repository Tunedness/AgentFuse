import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The transport/engine boundary, enforced.
 *
 * `bridge.ts`, `era.ts`, `remap.ts` and `diagnostics.ts` are pure MCP plumbing.
 * McpGuard's ADR anticipates lifting exactly this skeleton into a shared
 * internal package, and a single `@agentfuse/core` import anywhere in it turns
 * that move into a rewrite. Only `tools-call.ts` and `trip-result.ts` — plus
 * the two serving entries that wire them up — know the decision engine exists.
 *
 * `packages/core/src/purity.test.ts` is the precedent this follows: an
 * architectural rule that is only written down is an architectural rule that
 * drifts.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

/** Files that must not know the engine exists. */
const ENGINE_FREE = ['bridge.ts', 'era.ts', 'remap.ts', 'diagnostics.ts'];

/** `import x from 'y'`, `export … from 'y'`, `import('y')`, `require('y')`. */
const SPECIFIER_RE =
  /(?:\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gm;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // `src/testing/` is test scaffolding that happens not to end in
    // `.test.ts`; the package build excludes it, so it never ships and the
    // rules below do not apply to it.
    if (entry.isDirectory()) {
      if (entry.name !== 'testing') out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strips comments, so prose that *names* a forbidden import is not one. */
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

function read(file: string): string {
  return stripComments(readFileSync(join(SRC, file), 'utf8'));
}

describe('the transport/engine boundary', () => {
  it.each(ENGINE_FREE)('%s does not import @agentfuse/core', (file) => {
    const offenders = specifiers(read(file)).filter(
      (specifier) => specifier === '@agentfuse/core' || specifier.startsWith('@agentfuse/core/'),
    );

    expect(offenders).toEqual([]);
  });

  it.each(ENGINE_FREE)('%s does not import a sibling that imports the engine', (file) => {
    const engineAware = [
      './tools-call.js',
      './trip-result.js',
      './stdio-wrap.js',
      './http-serve.js',
    ];
    const offenders = specifiers(read(file)).filter((specifier) => engineAware.includes(specifier));

    expect(offenders).toEqual([]);
  });

  it('keeps every engine-free file present, so the list cannot rot silently', () => {
    const present = new Set(sourceFiles(SRC).map((file) => file.slice(SRC.length)));

    for (const file of ENGINE_FREE) expect(present.has(file)).toBe(true);
  });

  it('names every file that does import the engine, so the list stays deliberate', () => {
    const importers = sourceFiles(SRC)
      .filter((file) =>
        specifiers(stripComments(readFileSync(file, 'utf8'))).some(
          (specifier) =>
            specifier === '@agentfuse/core' || specifier.startsWith('@agentfuse/core/'),
        ),
      )
      .map((file) => file.slice(SRC.length))
      .sort();

    // Adding a file here is a decision, not a formality: every entry is one
    // more thing McpGuard cannot lift without rewriting.
    expect(importers).toEqual([
      'http-serve.ts',
      'stdio-wrap.ts',
      'tools-call.ts',
      'trip-result.ts',
    ]);
  });
});

describe('stdout discipline', () => {
  /**
   * In stdio wrap mode stdout carries JSON-RPC frames and nothing else. The
   * only writer is the SDK's `StdioServerTransport`; anything in this package
   * that reaches for stdout or `console` would corrupt the stream for every
   * message after it.
   */
  it('no source file writes to stdout or console', () => {
    const banned = [/\bconsole\s*\./, /\bprocess\s*\.\s*stdout\b/];
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of banned) {
        if (pattern.test(source)) offenders.push(`${file.slice(SRC.length)}: ${pattern.source}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
