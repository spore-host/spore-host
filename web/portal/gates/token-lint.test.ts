// Gate: portal stylesheets use tokens only. Runs on the real files, and on
// deliberately broken input to prove it can fail.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { rawValues } from "./token-lint.js";

const src = resolve(import.meta.dirname, "../src");

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : [],
  );
}

describe("token lint gate", () => {
  const files = cssFiles(src).filter((f) => !f.endsWith("tokens.css"));

  it("finds the stylesheets it is meant to check", () => {
    // A gate that checks nothing must not pass.
    expect(files.map((f) => relative(src, f)).sort()).toEqual(expect.arrayContaining(["styles/components.css", "styles/layout.css"]));
  });

  for (const f of files) {
    it(`${relative(src, f)} uses tokens only`, () => {
      const found = rawValues(readFileSync(f, "utf8")).map((r) => `line ${r.line}: ${r.value} in "${r.text}"`);
      expect(found).toEqual([]);
    });
  }

  it("fails on a raw hex colour, a raw length and rgb()", () => {
    const broken = ".x { color: #586172; padding: 12px; margin: 1.5rem; background: rgb(0 0 0); }";
    expect(rawValues(broken).map((r) => r.value).sort()).toEqual(["#586172", "1.5rem", "12px", "rgb("]);
  });

  it("allows tokens, media queries, percentages and comments", () => {
    const ok = "/* 12px in a comment */\n@media (max-width: 719.98px) {\n.x { padding: var(--space-3); inline-size: 60%; flex: 1 1 16ch; }\n}";
    expect(rawValues(ok)).toEqual([]);
  });

  it("does not mistake a token name containing digits for a length", () => {
    expect(rawValues(".x { padding: var(--space-16); }")).toEqual([]);
  });
});
