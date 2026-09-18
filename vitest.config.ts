import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Runs before any test file. Repoints HOME at a sandbox, proves it worked,
    // and arms the write guard - see tests/setup/isolate.ts. Without this a
    // single bad default could have the suite rewriting a real home directory.
    setupFiles: ['tests/setup/isolate.ts'],
    // Filesystem-heavy integration tests get their own temp dirs, but keep the
    // default pool so a hung test cannot wedge the whole suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
