// Gate: the banned-words copy lint over the copy that lives in modules (the
// error catalogue, the session alert, the glossary's own 'say' column). The
// rendered pages are linted by e2e/copy.spec.ts. Includes deliberately broken
// copy to prove it can fail.
import { describe, expect, it } from "vitest";
import { CATALOGUE } from "../src/copy/errors.js";
import { describeFindings, glossary, lintCopy, phraseRegex } from "../src/copy/lint.js";
import { EXPIRED_BODY, EXPIRED_TITLE, WARNING_BODY, warningTitle } from "../src/shell/session-alert.js";

describe("copy lint gate", () => {
  it("the error catalogue uses only glossary words", () => {
    const problems = Object.values(CATALOGUE).flatMap((e) =>
      [e.title, e.cause, e.action.label].flatMap((text) => describeFindings(`errors.${e.kind}`, text, lintCopy(text))),
    );
    expect(problems).toEqual([]);
  });

  it("the sign-in expiry alert uses only glossary words", () => {
    for (const text of [warningTitle(4), warningTitle(1), WARNING_BODY, EXPIRED_TITLE, EXPIRED_BODY]) {
      expect(describeFindings("session-alert", text, lintCopy(text))).toEqual([]);
    }
  });

  it("every catalogue error has three parts and an action verb", () => {
    for (const e of Object.values(CATALOGUE)) {
      expect(e.title.length, e.kind).toBeGreaterThan(0);
      expect(e.cause.length, e.kind).toBeGreaterThan(0);
      // Sentence case: a capital first letter, and no Title Case Words After It.
      expect(e.action.label, e.kind).toMatch(/^[A-Z][a-z]/);
      expect(e.title.split(" ").slice(1).filter((w) => /^[A-Z][a-z]/.test(w) && !["AWS", "I"].includes(w)), e.kind).toEqual([]);
    }
  });

  it("fails on banned words, the old noun and tool names", () => {
    const broken = "Your machine will shut down when its TTL ends. Ask spawn to reap the orphan in us-east-1.";
    const found = lintCopy(broken).map((f) => f.match.toLowerCase());
    expect(found).toEqual(expect.arrayContaining(["machine", "shut down", "ttl", "spawn", "reap", "orphan", "us-east-1"]));
  });

  it("matches across hyphens and spaces, and whole words only", () => {
    expect(lintCopy("Standard on-demand price").map((f) => f.match)).toEqual(["on-demand"]);
    expect(lintCopy("Tick the checkbox")).toEqual([]);
    expect(lintCopy("The nodes are ready").map((f) => f.match)).toEqual(["nodes"]);
    expect(phraseRegex("shut down").test("shutdown")).toBe(false);
  });

  it("allows the glossary's own basic words", () => {
    for (const t of ["instance", "time limit", "spending limit", "terminate", "stop", "start", "extend", "connect", "location", "Spot", "watch", "hold"]) {
      expect(lintCopy(t), t).toEqual([]);
    }
  });

  it("the glossary bans the old noun and keeps 'instance' allowed (owner decision on D2)", () => {
    const instance = glossary.terms.find((t) => t.concept === "instance")!;
    expect(instance.say).toBe("instance");
    expect(instance.dontSay).toContain("machine");
    expect(glossary.terms.flatMap((t) => t.dontSay)).not.toContain("instance");
  });

  it("no banned term is also a basic word", () => {
    const say = new Set(glossary.terms.map((t) => t.concept.toLowerCase()));
    const clashes = glossary.terms.flatMap((t) => t.dontSay).filter((d) => say.has(d.toLowerCase()));
    expect(clashes).toEqual([]);
  });
});
