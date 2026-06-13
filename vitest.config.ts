import { defineConfig } from 'vitest/config';

// Unit tests: fast, fully mocked HTTP (undici MockAgent). No live SAP Cloud ALM access.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.d.ts'],
    },
  },
});
