// The published pages load no script or stylesheet from another origin, and
// every integrity value they set matches the vendored file it names (#700).
// A third-party script runs with spore.host's authority, which the portal
// will share, so the homepage's runtimes (Rive, asciinema-player) are
// vendored under assets/vendor/ and pinned.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const web = resolve(import.meta.dirname, "..");
// The pages copy-static.mjs publishes.
const pages = ["index.html", "privacy.html", "terms.html", "library.html", "app/index.html"];

function vendoredHashes(algo) {
  const dir = resolve(web, "assets/vendor");
  return readdirSync(dir, { recursive: true })
    .map((f) => resolve(dir, f))
    .filter((f) => statSync(f).isFile())
    .map((f) => createHash(algo).update(readFileSync(f)).digest("base64"));
}

describe("vendored runtimes (#700)", () => {
  for (const page of pages) {
    const html = readFileSync(resolve(web, page), "utf8");

    it(`${page} loads no third-party script or stylesheet`, () => {
      // Static tags.
      expect(html).not.toMatch(/<script\b[^>]*\bsrc=["']?(https?:)?\/\//i);
      expect(html).not.toMatch(/<link\b(?=[^>]*stylesheet)[^>]*\bhref=["']?(https?:)?\/\/(?!fonts\.googleapis\.com)/i);
      // Dynamically built URLs, as the old asciinema loader did.
      expect(html).not.toMatch(/cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/i);
    });

    it(`${page}: every integrity value is the hash of a vendored file`, () => {
      for (const [, algo, value] of html.matchAll(/integrity\s*[=:]\s*["'](sha256|sha384|sha512)-([^"']+)["']/g)) {
        expect(vendoredHashes(algo), `${algo}-${value}`).toContain(value);
      }
    });
  }

  it("index.html pins both asciinema-player files", () => {
    const html = readFileSync(resolve(web, "index.html"), "utf8");
    for (const [file, algo] of [["asciinema-player.min.js", "sha384"], ["asciinema-player.css", "sha384"]]) {
      const digest = createHash(algo).update(readFileSync(resolve(web, "assets/vendor/asciinema-player", file))).digest("base64");
      expect(html).toContain(`/${file}'`);
      expect(html).toContain(`${algo}-${digest}`);
    }
  });
});
