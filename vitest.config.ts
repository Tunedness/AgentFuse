import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest 5 replaced the standalone `vitest.workspace.ts` file with this
    // `test.projects` array. Each entry is a directory containing a
    // package.json; the package name becomes the project name in the reporter.
    projects: ['packages/*', 'bench'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/dist/**'],
      // TODO(phase-2): the policy engine lands in @agentfuse/core and brings the
      // real test suite with it. Raise these to 90 (lines/functions/branches/
      // statements) and make coverage a blocking CI gate at that point. They are
      // pinned at 0 for now so the scaffold does not fail on an empty suite.
      thresholds: {
        'packages/core/src/**': {
          lines: 0,
          functions: 0,
          branches: 0,
          statements: 0,
        },
      },
    },
  },
});
