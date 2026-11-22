import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/unit/**/*.test.{ts,mjs}'],
    environment: 'node',
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
