import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest 5 replaced the standalone `vitest.workspace.ts` file with this
    // `test.projects` array. Each entry is a directory containing a
    // package.json; the package name becomes the project name in the reporter.
    projects: ['packages/*', 'bench'],
    coverage: {
      // On by default, so `npm test` is the gate rather than a separate command
      // somebody remembers to run. The whole suite takes well under a second.
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/dist/**'],
      // `@agentfuse/core` is the whole product's safety net: if its decisions
      // are wrong, a working agent gets halted or a runaway one does not. The
      // gate is deliberately only on core — the proxy and CLI are thin, and
      // padding their numbers would tell nobody anything.
      thresholds: {
        'packages/core/src/**': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
      },
    },
  },
});
