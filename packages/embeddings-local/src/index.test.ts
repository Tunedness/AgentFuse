import { describe, expect, it } from 'vitest';
import * as pkg from './index.js';

/**
 * The entry point is a contract with `packages/cli/src/embeddings.ts`, which
 * finds this package by dynamic `import()` and looks for exactly two factories.
 * A build that exported neither would be classified as "installed but too old"
 * and silently drop the semantic tier, so the surface is pinned from this side
 * as well as from the CLI's.
 */
describe('the package surface', () => {
  it('exports the two factories the CLI loads it for', () => {
    expect(typeof pkg.createEmbeddingProvider).toBe('function');
    expect(typeof pkg.installModel).toBe('function');
  });

  it('answers to the provider name a policy writes', () => {
    // `loop_detection.semantic.provider: local`.
    expect(pkg.BACKEND_ID).toBe('local');
  });

  it('names the same default model the CLI does', () => {
    // `commands/models.ts` carries its own `DEFAULT_MODEL` because
    // `models install` has to run without a policy; the two must agree.
    expect(pkg.DEFAULT_MODEL).toBe('Xenova/all-MiniLM-L6-v2');
    expect(pkg.KNOWN_MODELS[pkg.DEFAULT_MODEL]?.dims).toBe(384);
  });

  it('carries a version for reports and diagnostics', () => {
    expect(pkg.EMBEDDINGS_LOCAL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
