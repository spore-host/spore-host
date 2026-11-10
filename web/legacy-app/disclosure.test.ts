import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  atLeast,
  DEFAULT_LEVEL,
  isLevel,
  LEVEL_CONTROL_NAME,
  LEVEL_INFO,
  LEVELS,
  loadLevel,
  saveLevel,
  type DisclosureLevel,
} from "./disclosure.js";

/** An in-memory Storage stand-in, so no test depends on the real localStorage. */
function fakeStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    /** Test-only peek. */
    _map: map,
  };
}

/** A Storage that throws on every access — Safari private mode, blocked cookies. */
const throwingStorage = {
  getItem(): string | null {
    throw new Error("SecurityError");
  },
  setItem(): void {
    throw new Error("SecurityError");
  },
};

describe("atLeast", () => {
  it("is true at the level itself", () => {
    for (const l of LEVELS) expect(atLeast(l, l)).toBe(true);
  });

  it("is true above and false below", () => {
    expect(atLeast("expert", "standard")).toBe(true);
    expect(atLeast("expert", "guided")).toBe(true);
    expect(atLeast("standard", "guided")).toBe(true);
    expect(atLeast("guided", "standard")).toBe(false);
    expect(atLeast("guided", "expert")).toBe(false);
    expect(atLeast("standard", "expert")).toBe(false);
  });

  // The ordering is the contract every surface depends on. If LEVELS is ever
  // reordered, the whole portal silently inverts — hence a direct assertion
  // rather than trusting the array's declaration order.
  it("orders guided < standard < expert", () => {
    expect(LEVELS).toEqual(["guided", "standard", "expert"]);
  });
});

describe("isLevel", () => {
  it("accepts exactly the known levels", () => {
    for (const l of LEVELS) expect(isLevel(l)).toBe(true);
  });

  it("rejects everything else", () => {
    for (const v of ["", "GUIDED", "mom", "space-shuttle", null, undefined, 0, 1, {}, []]) {
      expect(isLevel(v)).toBe(false);
    }
  });
});

describe("loadLevel / saveLevel", () => {
  it("round-trips through storage", () => {
    const s = fakeStorage();
    saveLevel("expert", s);
    expect(loadLevel(s)).toBe("expert");
  });

  it("defaults to guided when nothing is stored", () => {
    expect(loadLevel(fakeStorage())).toBe("guided");
    expect(DEFAULT_LEVEL).toBe("guided");
  });

  // The reason the default is guided, asserted so a later "nicer default"
  // refactor has to argue with a test: if the default were standard, the mode
  // built for the least-experienced user is the one they'd never see.
  it("defaults to the LEAST revealing level", () => {
    expect(DEFAULT_LEVEL).toBe(LEVELS[0]);
  });

  it("ignores a stored value that isn't a level", () => {
    // A hand-edited or stale localStorage entry must not become the level: every
    // atLeast() comparison against an unknown string reads as below-guided, which
    // would hide the whole portal with no visible cause.
    expect(loadLevel(fakeStorage({ "spore.disclosure": "cockpit" }))).toBe("guided");
    expect(loadLevel(fakeStorage({ "spore.disclosure": "" }))).toBe("guided");
  });

  it("survives storage that throws", () => {
    // A portal that fails to load because it couldn't read a UI preference is a
    // worse outcome than one that starts in guided mode.
    expect(() => loadLevel(throwingStorage)).not.toThrow();
    expect(loadLevel(throwingStorage)).toBe("guided");
    expect(() => saveLevel("expert", throwingStorage)).not.toThrow();
  });

  it("survives storage being absent entirely", () => {
    expect(loadLevel(null)).toBe("guided");
    expect(() => saveLevel("expert", null)).not.toThrow();
  });
});

describe("LEVEL_INFO", () => {
  it("describes every level", () => {
    for (const l of LEVELS) {
      expect(LEVEL_INFO[l].label.length).toBeGreaterThan(0);
      // The blurb is what the picker shows; a level with no explanation is a
      // control the user has to guess at.
      expect(LEVEL_INFO[l].blurb.length).toBeGreaterThan(0);
    }
  });

  it("has no entries beyond LEVELS", () => {
    expect(Object.keys(LEVEL_INFO).sort()).toEqual([...LEVELS].sort());
  });

  it("is exhaustive by type", () => {
    // Compile-time companion to the runtime check above: adding a level to the
    // union without an entry here is a type error, not a blank tooltip.
    const check: Record<DisclosureLevel, unknown> = LEVEL_INFO;
    expect(check).toBeTruthy();
  });
});

describe("LEVEL_CONTROL_NAME", () => {
  // A source scan, not a DOM assertion, because the failure this guards against is
  // cross-file: the control was called "Detail", lagotto and terminal each told the
  // user so in a warning about losing a running watch or SSM session, and renaming it
  // to "Mode" left both pointing at a control that no longer existed. Every per-file
  // test still passed. Nothing but a scan catches that.
  const SRC = ["shell.ts", "surfaces/lagotto.ts", "surfaces/terminal.ts"];
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

  it("is what every reference to the control interpolates", () => {
    for (const f of SRC) {
      const src = read(f);
      // Skip comments: they explain the rename, so they legitimately say "Detail".
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${f} interpolates the constant`).toContain("LEVEL_CONTROL_NAME");
      // No hard-coded name in a user-visible string. `<b>Mode</b>` and "changing Mode"
      // are exactly what drifted.
      expect(code, `${f} has no hard-coded control name`).not.toMatch(
        /<b>\s*(Mode|Detail)\s*<\/b>|(changing|switching|change this any time with)\s+(the\s+)?(Mode|Detail|detail level)/i,
      );
    }
  });

  it("names a control the user can find", () => {
    // The name has to match the header label, or the instruction is unfollowable.
    expect(read("shell.ts")).toContain('class="portal-level-label"');
    expect(LEVEL_CONTROL_NAME.trim()).toBe(LEVEL_CONTROL_NAME);
    expect(LEVEL_CONTROL_NAME.length).toBeGreaterThan(0);
  });
});
