import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    environment: 'node',
    // The simulation, round-trip and adapter suites run real sharp work and can take several seconds per test.
    testTimeout: 20_000,
    include: [
      'packages/**/test/**/*.test.{ts,tsx}',
      'packages/**/test/**/*.spec.{ts,tsx}',
      'apps/**/test/**/*.test.{ts,tsx}',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
    },
  },
});
