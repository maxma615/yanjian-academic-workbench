import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 60000, fullyParallel: false, workers: 1,
  expect: { timeout: 7000 }, reporter: 'list', outputDir: 'test-results',
  use: { headless: true, viewport: { width: 1440, height: 980 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
