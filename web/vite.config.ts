// vitest/config re-exports Vite's own defineConfig with the `test` key typed, so
// one config serves the dev server and the test run (the convention the three
// -ts libraries already use).
import { defineConfig } from "vitest/config";

// The production build no longer runs Vite (spore-host#645). spore.host/app is a
// static placeholder (app/index.html) while the portal is rebuilt from scratch,
// and `npm run build` is just scripts/copy-static.mjs, which copies it and the
// marketing pages into dist/. No bundle is built, so no old portal JS ships.
//
// The old portal lives on, unbuilt, in legacy-app/ for the rebuild to consult.
// Its tests still run (below) and it still typechecks (tsconfig.json), so it
// stays a trustworthy reference rather than rotting silently. `npm run dev`
// still serves it locally at /legacy-app/index.html.
//
// base:"./" keeps asset URLs relative under `vite dev`.
export default defineConfig({
  root: __dirname,
  base: "./",
  test: {
    // happy-dom, not jsdom: the portal's own tests only need document/localStorage
    // and it's what the three -ts libraries already use, so one DOM shim across
    // the whole stack.
    environment: "happy-dom",
    include: ["legacy-app/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
