import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], exclude: ['tests/e2e/**', 'tests/desktop/**'], testTimeout: 15000, pool: 'forks' } });
