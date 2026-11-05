import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // The shared WebAdapter skeleton is what every real adapter relies on.
      thresholds: { 'src/base/**': { lines: 85, statements: 85, functions: 85, branches: 80 } },
    },
  },
});
