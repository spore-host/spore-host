// Unit tests and offline gates for the portal (npm run portal:test).
// Separate from vite.config.ts because vitest 2 carries its own Vite, whose
// plugin types differ from the Vite 6 that builds the app. No plugins are
// needed here: tests import source directly.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: resolve(__dirname),
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "gates/**/*.test.ts", "build/**/*.test.ts", "parity/**/*.test.ts", "iam/**/*.test.ts"],
    // The IAM inventory gate runs a real production build; give it room.
    testTimeout: 30_000,
  },
});
