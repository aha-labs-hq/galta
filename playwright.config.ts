import { defineConfig } from '@playwright/test'
import { acceptanceOrigin, devOrigin, devPort } from './scripts/lib/acceptance'

// Tests run in parallel. `bun run test:browser` then runs the tests tagged
// @serial, which measure frame timing or use the system clipboard, on their own.
export default defineConfig({
  testDir: './tests/browser', fullyParallel: true, workers: '50%', timeout: 60_000,
  use: { baseURL: devOrigin, viewport: { width: 1440, height: 1000 }, launchOptions: { executablePath: process.env.GALTA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, screenshot: 'only-on-failure' },
  webServer: [{ command: `bun run --cwd apps/extension dev --host 127.0.0.1 --port ${devPort} --strictPort`, url: `${devOrigin}/dev/scene-test.html`, reuseExistingServer: !process.env.CI }, { command: 'bun scripts/preview-built.ts', url: `${acceptanceOrigin}/sidepanel/index.html`, reuseExistingServer: false }],
})
