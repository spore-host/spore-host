// Playwright gates for the portal (npm run portal:e2e): axe, keyboard, 320 px
// reflow, rendered copy lint, the rendered CLI⇄GUI matrix, and the self-test
// that proves each of them can fail.
//
// They run against `vite preview` of the GATE build (web/.portal-build/gate),
// a local server only. Nothing is deployed and no AWS endpoint is reachable:
// e2e/fixtures.ts aborts every request to AWS, the API or the sign-in service
// and fails the test that made it.
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const web = resolve(import.meta.dirname, "..");
const PORT = 4317;

export default defineConfig({
  testDir: resolve(import.meta.dirname, "e2e"),
  outputDir: resolve(import.meta.dirname, "test-results"),
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    colorScheme: "light",
    reducedMotion: "reduce",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: `npx vite build --config portal/vite.config.ts --mode gate --logLevel warn && npx vite preview --config portal/vite.config.ts --mode gate --port ${PORT} --strictPort`,
    cwd: web,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
