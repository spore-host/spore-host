// vitest/config re-exports Vite's own defineConfig with the `test` key typed, so
// one config serves both the build and the test run (the convention the three
// -ts libraries already use).
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Vite builds ONLY the portal SPA (app/) — it's the sole page with a module
// graph. The marketing pages (index/privacy/terms/library) are plain no-build
// HTML+CSS and are copied verbatim into dist/ by scripts/copy-static.mjs after
// the build; Vite never parses them (they contain literal `&` in URLs that its
// strict HTML parser rejects, and it would gain nothing by touching them).
// base:"./" keeps portal asset URLs relative so dist/ works behind CloudFront
// and in `vite preview`.
export default defineConfig({
  root: __dirname,
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: { app: resolve(__dirname, "app/index.html") },
    },
  },
  test: {
    // happy-dom, not jsdom: the portal's own tests only need document/localStorage
    // and it's what the three -ts libraries already use, so one DOM shim across
    // the whole stack.
    environment: "happy-dom",
    include: ["app/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
