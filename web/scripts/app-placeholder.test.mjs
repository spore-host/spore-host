// spore.host/app is a static placeholder while the portal is rebuilt
// (spore-host#645). These pin the properties the deploy relies on: the marker
// deploy-site.yaml checks for, no JavaScript at all (so no old portal bundle can
// be referenced), and the links a visitor needs to carry on with the CLIs.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const web = resolve(import.meta.dirname, "..");
const html = readFileSync(resolve(web, "app/index.html"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(web, "package.json"), "utf8"));

describe("app/index.html placeholder", () => {
  it("carries the marker the deploy's live check asserts", () => {
    expect(html).toContain('<meta name="spore-host-page" content="app-placeholder">');
  });

  it("ships no script at all, so it cannot load the old portal bundle", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("main.ts");
    expect(html).not.toMatch(/assets\/app-/);
  });

  it("has one real heading saying the app is being rebuilt", () => {
    expect(html).toContain('<html lang="en">');
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toMatch(/<h1>[^<]*being rebuilt[^<]*<\/h1>/);
    expect(html).toContain("isn't available right now");
  });

  it("points at the three CLIs, their install docs and the quick start", () => {
    for (const tool of ["spawn", "truffle", "lagotto"]) {
      expect(html).toContain(`https://docs.spore.host/tools/${tool}`);
      expect(html).toContain(`brew install spore-host/tap/${tool}`);
      expect(html).toContain(`https://github.com/spore-host/${tool}/releases/latest`);
    }
    expect(html).toContain("scoop install spawn truffle lagotto");
    expect(html).toContain("https://docs.spore.host/guides/installation");
    expect(html).toContain("https://docs.spore.host/quickstart");
  });
});

describe("the production build", () => {
  // The old portal is kept unbuilt in legacy-app/; bundling it again would put
  // its JS back on spore.host.
  it("does not run a Vite bundle", () => {
    expect(pkg.scripts.build).not.toMatch(/vite build/);
  });
});
