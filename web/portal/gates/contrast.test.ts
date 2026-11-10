// Gate: every token colour pair meets WCAG 2.2 AA. Runs on the real tokens,
// and on deliberately broken tokens to prove it can fail.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastProblems, contrastRatio, parseTokens, resolveToken, type PairsFile } from "./contrast.js";

const styles = resolve(import.meta.dirname, "../src/styles");
const css = readFileSync(resolve(styles, "tokens.css"), "utf8");
const pairs = JSON.parse(readFileSync(resolve(styles, "contrast-pairs.json"), "utf8")) as PairsFile;

describe("token contrast gate", () => {
  it("the shipped tokens pass every pair, and every colour token is checked", () => {
    expect(contrastProblems(css, pairs)).toEqual([]);
  });

  it("checks a meaningful number of pairs", () => {
    expect(pairs.pairs.length).toBeGreaterThanOrEqual(30);
  });

  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // The brief's own figures for two of its tokens.
    expect(contrastRatio("#111827", "#ffffff")).toBeCloseTo(17.74, 1);
    expect(contrastRatio("#4059e5", "#ffffff")).toBeCloseTo(5.56, 1);
  });

  it("fails when a text colour is lightened below 4.5:1", () => {
    const broken = css.replace("--color-text-muted: #586172;", "--color-text-muted: #9aa1ad;");
    const problems = contrastProblems(broken, pairs);
    expect(problems.some((p) => p.startsWith("--color-text-muted on --color-surface is"))).toBe(true);
  });

  it("fails on the brief's original control border, which is under 3:1 on the subtle surface", () => {
    const broken = css.replace(/--color-border-control: #[0-9a-f]+;/, "--color-border-control: #8a93a3;");
    expect(contrastProblems(broken, pairs)).toEqual([
      expect.stringContaining("--color-border-control on --color-surface-subtle is 2.91:1, needs 3:1"),
      expect.stringContaining("--color-border-control on --color-surface-sunken is 2.71:1, needs 3:1"),
    ]);
  });

  it("fails when a new colour token is in no pair", () => {
    const broken = css.replace("--color-text: #111827;", "--color-text: #111827;\n  --color-new-accent: #db2777;");
    expect(contrastProblems(broken, pairs)).toContain("--color-new-accent is in no contrast pair and not exempted: add a pair to contrast-pairs.json");
  });

  it("does not round a near miss up to a pass", () => {
    // #767676 on white is 4.54:1; #777777 is 4.48:1, which a rounding check would call 4.5.
    const t = parseTokens(":root { --a: #777777; --b: #ffffff; }");
    const problems = contrastProblems(":root { --color-a: #777777; --color-b: #ffffff; }", {
      pairs: [{ fg: "--color-a", bg: "--color-b", min: 4.5, use: "test" }],
      exempt: {},
    });
    expect(resolveToken(t, "--a")).toBe("#777777");
    expect(problems).toHaveLength(1);
  });

  it("resolves var() aliases and rejects cycles", () => {
    const t = parseTokens(":root { --x: #fff; --y: var(--x); --p: var(--q); --q: var(--p); }");
    expect(resolveToken(t, "--y")).toBe("#fff");
    expect(() => resolveToken(t, "--p")).toThrow(/cycle/);
  });
});
