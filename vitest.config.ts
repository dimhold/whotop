import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov'],
      /**
       * A floor, not a target. It is set just under where the suite actually
       * stands, so that coverage cannot quietly rot, and low enough not to
       * invite tests written for the number rather than for the behaviour.
       *
       * What is under it is known and named in CONTRIBUTING: the Linux and
       * macOS collectors read /proc and spawn ss and lsof directly, and
       * testing them means a filesystem seam that does not exist yet. Their
       * parsers, which is where the difficult part lives, are at 99%.
       */
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
      },
    },
  },
});
