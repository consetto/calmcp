import { defineConfig } from 'vitest/config';

// Integration tests: hit live SAP Cloud ALM (sandbox API key or destination). Skipped when
// credentials are absent so the suite stays green in CI without secrets.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
  },
});
