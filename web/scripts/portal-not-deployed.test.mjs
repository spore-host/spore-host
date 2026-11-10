// The rebuilt portal (web/portal/, spore-host#683) must NOT reach spore.host
// until slice 1 (#684) passes its gates. spore.host/app/ keeps serving the
// placeholder (app-placeholder.test.mjs pins that page).
//
// Mechanism: deploy-site.yaml publishes web/dist/ only, and `npm run build`
// (copy-static.mjs) fills dist/ from an explicit list that does not include
// the portal. The portal's own Vite config writes to web/.portal-build/,
// which nothing syncs. These tests run in `npm test`, which deploy-site runs
// before it uploads, so a change that wires the portal into the deploy fails
// the deploy itself. Slice 1 changes these tests in the same PR that ships it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const web = resolve(import.meta.dirname, "..");
// Code only: both files explain the portal in comments, which is fine.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const copyStatic = code(readFileSync(resolve(web, "scripts/copy-static.mjs"), "utf8"));
const portalVite = code(readFileSync(resolve(web, "portal/vite.config.ts"), "utf8"));
const pkg = JSON.parse(readFileSync(resolve(web, "package.json"), "utf8"));
const portalIndex = readFileSync(resolve(web, "portal/index.html"), "utf8");

const ARRAYS = { pages: /const pages = (\[[^\]]*\])/, dirs: /const dirs = (\[[^\]]*\])/ };

function arrayLiteral(src, name) {
  const m = src.match(ARRAYS[name]);
  if (!m) throw new Error(`copy-static.mjs has no ${name} array`);
  return JSON.parse(m[1].replace(/'/g, '"'));
}

describe("the rebuilt portal is not deployed", () => {
  it("copy-static.mjs copies only the marketing pages and the /app placeholder", () => {
    expect(arrayLiteral(copyStatic, "pages")).toEqual(["index.html", "privacy.html", "terms.html", "library.html", "app/index.html"]);
    expect(arrayLiteral(copyStatic, "dirs")).toEqual(["css", "assets"]);
    expect(copyStatic).not.toMatch(/["'/]portal["'/]/);
  });

  it("the production build script does not build the portal", () => {
    expect(pkg.scripts.build).toBe("node scripts/copy-static.mjs");
    expect(pkg.scripts.deploy).not.toMatch(/portal/);
  });

  it("the portal builds into web/.portal-build/, never dist/", () => {
    expect(portalVite).toContain('export const BUILD_ROOT = resolve(web, ".portal-build");');
    expect(portalVite).toMatch(/outDir: resolve\(BUILD_ROOT, /);
    expect(portalVite).not.toMatch(/["'/]dist["'/]/);
  });

  it("the portal carries a marker the deploy checks for, distinct from the placeholder's", () => {
    expect(portalIndex).toContain('<meta name="spore-host-page" content="portal">');
    expect(portalIndex).not.toContain('content="app-placeholder"');
  });

  it(".portal-build/ is gitignored, so a local build is never committed", () => {
    expect(readFileSync(resolve(web, ".gitignore"), "utf8")).toMatch(/^\.portal-build\/$/m);
  });
});
