import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/desktop',
  testMatch: /.*\.test\.ts/,
  fullyParallel: false,
  workers: 1,
  outputDir: 'desktop-test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: '.test-data/desktop-playwright-report', open: 'never' }]],
});
