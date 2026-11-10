// The rebuilt portal (spore-host#645, Phase 0 #683). NOT DEPLOYED.
//
// deploy-site.yaml publishes web/dist/, which `npm run build`
// (scripts/copy-static.mjs) fills with the marketing pages and the /app
// placeholder only. This config never writes there: every build goes to
// web/.portal-build/<mode>/, which is gitignored and synced by nothing.
// scripts/portal-not-deployed.test.mjs (run by the deploy itself, via
// `npm test`) and the deploy workflows' "no portal in dist" step enforce it.
//
// Modes:
//   production  what slice 1 will ship. Only index.html. Writes the SDK
//               command report the IAM coverage gate reads.
//   gate        what the Playwright gates test: production code plus the test
//               hooks (.env.gate) and the component gallery and gate self-test
//               pages.
//
// Shipping it at /app/ is slice 1's change (#684): point copy-static.mjs (or a
// vite build) at this app instead of app/index.html, and update the
// placeholder checks in the same PR.
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { sdkCommandsPlugin } from "./build/sdk-commands-plugin.js";

const portal = __dirname;
const web = resolve(portal, "..");

export const BUILD_ROOT = resolve(web, ".portal-build");

export default defineConfig(({ mode }) => {
  const gate = mode === "gate";
  const input: Record<string, string> = { index: resolve(portal, "index.html") };
  if (gate) {
    input.gallery = resolve(portal, "gallery.html");
    input.selftest = resolve(portal, "selftest.html");
  }
  return {
    root: portal,
    envDir: portal,
    base: "./",
    publicDir: false,
    plugins: [sdkCommandsPlugin({ reportFile: resolve(BUILD_ROOT, "reports", `sdk-commands.${mode}.json`) })],
    build: {
      outDir: resolve(BUILD_ROOT, gate ? "gate" : "production"),
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        input,
      },
    },
    server: { port: 4318, strictPort: true },
    preview: { port: 4317, strictPort: true },
  };
});
