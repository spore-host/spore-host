import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyStaticFlags } from "./static-flags.mjs";

const page = `<p>a</p><!-- experimental:chat --><p>chat</p><!-- /experimental:chat --><p>b</p>`;

describe("applyStaticFlags", () => {
  it("drops a chat block by default", () => {
    expect(applyStaticFlags(page, {})).toBe("<p>a</p><p>b</p>");
    expect(applyStaticFlags(page, { VITE_EXPERIMENTAL_CHAT: "1" })).toBe("<p>a</p><p>b</p>");
  });

  it("keeps it, without the markers, when the build opts in", () => {
    expect(applyStaticFlags(page, { VITE_EXPERIMENTAL_CHAT: "true" })).toBe(
      "<p>a</p><p>chat</p><p>b</p>",
    );
  });

  it("refuses markers it cannot pair, rather than shipping a hidden block", () => {
    expect(() => applyStaticFlags("<!-- experimental:chat -->x", {})).toThrow(/never closed/);
    expect(() => applyStaticFlags("x<!-- /experimental:chat -->", {})).toThrow(/unmatched/);
    expect(() => applyStaticFlags("<!-- experimental:chatt -->x<!-- /experimental:chatt -->", {})).toThrow(/unknown flag/);
    expect(() =>
      applyStaticFlags("<!-- experimental:chat --><!-- experimental:chat -->", {}),
    ).toThrow(/opened inside/);
  });

  it("leaves no chat integration on the deployed homepage", () => {
    const html = readFileSync(resolve(import.meta.dirname, "..", "index.html"), "utf8");
    const out = applyStaticFlags(html, {}, "index.html");
    for (const needle of ["Spore-bot", "spore-bot", "Slack", "Microsoft Teams", "slack-setup"]) {
      expect(out, needle).not.toContain(needle);
    }
    expect(out).not.toContain("experimental:");
  });
});
