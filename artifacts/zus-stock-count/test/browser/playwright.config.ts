import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: testDirectory,
  testMatch: 'outlet-access.spec.ts',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4178',
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || '/repl/tools/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },
  webServer: {
    command: 'pnpm exec vite --config test/browser/vite.e2e.config.ts',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
