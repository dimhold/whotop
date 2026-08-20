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
      // The branch number moved from 84% to 76% between vitest 2 and 4 with
      // no test and no line of source changed: v8 counts branches
      // differently now. The floor follows the measurement rather than
      // pretending the code got worse, which is why it is written down here
      // with the reason attached instead of being quietly edged down.
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
      },
    },
  },
});
