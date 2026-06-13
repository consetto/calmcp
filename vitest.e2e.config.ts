import { defineConfig } from 'vitest/config';

// End-to-end tests: spawn the built server and issue real MCP calls over stdio and HTTP.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
  },
});
