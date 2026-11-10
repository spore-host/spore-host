// Per-level rendering of the truffle surface. This is the surface where the
// disclosure axis is most visible — guided replaces the query box entirely — so it
// carries the assertions that the level is actually honoured rather than merely
// passed around.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../session.js";
import type { PortalConfig, SurfaceContext } from "./types.js";
import type { DisclosureLevel } from "../disclosure.js";
import { GUIDED_SHAPES } from "../guided/shapes.js";
import { readHashParam } from "../hashstate.js";
import { truffleSurface } from "./truffle.js";

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Type into the query box and submit, as a user would. */
function search(host: HTMLElement, q: string): void {
  host.querySelector<HTMLInputElement>(".truffle-q")!.value = q;
  host
    .querySelector<HTMLFormElement>(".truffle-form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
}

const config = { region: "us-east-1" } as PortalConfig;

function ctxAt(level: DisclosureLevel, navigate = vi.fn()): SurfaceContext {
  const session = new SessionController("us-east-1", null);
  session.setLevel(level);
  return { session, config, level, navigate };
}

describe("truffleSurface disclosure", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    // The surface persists its query in the hash and restores it at mount, so a
    // leftover `?q=` from an earlier test would silently pre-fill the next one.
    location.hash = "#/truffle";
  });

  it("shows the curated picker and NO query box at guided", async () => {
    // A free-text query is the wrong first question: "gpu with 80gb for training"
    // is only writable by someone who already knows what they need.
    const d = await truffleSurface.mount(host, ctxAt("guided"));
    await settle();
    expect(host.querySelector(".truffle-q")).toBeNull();
    expect(host.querySelectorAll(".guided-card").length).toBeGreaterThan(0);
    d.dispose();
  });

  it("shows the query box and NO picker from standard up", async () => {
    for (const level of ["standard", "expert"] as const) {
      host.innerHTML = "";
      const d = await truffleSurface.mount(host, ctxAt(level));
      await settle();
      expect(host.querySelector(".truffle-q"), level).not.toBeNull();
      expect(host.querySelector(".guided-card"), level).toBeNull();
      d.dispose();
    }
  });

  it("raises the level rather than navigating on the guided escape", async () => {
    // The user is saying "show me more", and the query box is one level up on this
    // very surface — navigating elsewhere would answer a different question.
    const navigate = vi.fn();
    const ctx = ctxAt("guided", navigate);
    const d = await truffleSurface.mount(host, ctx);
    await settle();
    host.querySelector<HTMLButtonElement>(".guided-escape")!.click();
    expect(ctx.session.level).toBe("standard");
    expect(navigate).not.toHaveBeenCalled();
    d.dispose();
  });

  it("carries the chosen shape to the instances surface", async () => {
    // This surface is auth-free by design, so there's no session to launch into —
    // the instances surface mounts the same picker with a live client behind it.
    //
    // The shape id has to ride along. Navigating bare is what shipped, and it dropped
    // the GuidedChoice on the floor: the user who picked "A big GPU for training"
    // arrived at an identical picker asking the same question again. Asserting the
    // exact id rather than just the presence of `shape=` is deliberate — carrying the
    // *wrong* card over would be worse than carrying none.
    const navigate = vi.fn();
    const d = await truffleSurface.mount(host, ctxAt("guided", navigate));
    await settle();
    host.querySelector<HTMLButtonElement>(".guided-card")!.click();
    expect(navigate).toHaveBeenCalledWith(`instances?shape=${GUIDED_SHAPES[0]!.id}`);
    d.dispose();
  });

  it("adds per-row detail only at expert", async () => {
    // If expert rendered identically to standard, the third level would be a lie.
    for (const [level, expected] of [
      ["standard", 0],
      ["expert", 1],
    ] as const) {
      host.innerHTML = "";
      const d = await truffleSurface.mount(host, ctxAt(level));
      await settle();
      host.querySelector<HTMLInputElement>(".truffle-q")!.value = "nvidia h100";
      host.querySelector<HTMLFormElement>(".truffle-form")!.dispatchEvent(
        new Event("submit", { cancelable: true }),
      );
      await settle();
      expect(host.querySelectorAll(".truffle-row").length, level).toBeGreaterThan(0);
      expect(
        host.querySelectorAll(".truffle-detail").length > 0,
        `${level} expected detail: ${expected === 1}`,
      ).toBe(expected === 1);
      d.dispose();
    }
  });

  it("states where an expert-level price came from", async () => {
    // An estimate presented as a price is the same defect as a fabricated one, and
    // expert is the level that can act on knowing which it is.
    const d = await truffleSurface.mount(host, ctxAt("expert"));
    await settle();
    host.querySelector<HTMLInputElement>(".truffle-q")!.value = "nvidia h100";
    host.querySelector<HTMLFormElement>(".truffle-form")!.dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await settle();
    expect(host.querySelector(".truffle-detail")!.textContent).toMatch(/live AWS pull|estimate/);
    d.dispose();
  });

  // Every example in the hint must return results. `gpu with 80gb for training`
  // shipped here while it silently returned CPU-only Graviton instances
  // (truffle-ts#37/#38) — an example query is the first thing a new user runs, so
  // a broken one is worse than none: it teaches them the tool doesn't work. It was
  // pulled, fixed upstream in 0.5.0, and restored, so this drives each example
  // through the real surface rather than trusting the version bump.
  //
  // Extracted from the hint rather than hardcoded, so adding an example to the copy
  // without checking it fails here instead of in front of a user.
  it("returns results for every example query in the hint", async () => {
    const d = await truffleSurface.mount(host, ctxAt("standard"));
    await settle();
    const examples = [...host.querySelectorAll(".truffle-hint code")].map((c) => c.textContent!);
    expect(examples.length).toBeGreaterThan(0);

    for (const q of examples) {
      host.querySelector<HTMLInputElement>(".truffle-q")!.value = q;
      host.querySelector<HTMLFormElement>(".truffle-form")!.dispatchEvent(
        new Event("submit", { cancelable: true }),
      );
      await settle();
      expect(host.querySelectorAll(".truffle-row").length, `example "${q}" matched nothing`)
        .toBeGreaterThan(0);
    }
    d.dispose();
  });

  it("does not answer a GPU query with CPU-only instances", async () => {
    // The precise shape of truffle-ts#37: the query parsed, ran, and returned a
    // ranked list of r8g/c7g boxes with no accelerator at all. It looked like a
    // working search, which is why it survived. A count assertion alone would
    // still pass on that output.
    const d = await truffleSurface.mount(host, ctxAt("standard"));
    await settle();
    host.querySelector<HTMLInputElement>(".truffle-q")!.value = "gpu with 80gb for training";
    host.querySelector<HTMLFormElement>(".truffle-form")!.dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await settle();
    const rows = [...host.querySelectorAll(".truffle-row")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.textContent, `${row.textContent} has no GPU`).toMatch(/gpu/i);
    }
    d.dispose();
  });

  // A level change re-mounts the surface, and the shell clears .portal-main to do it
  // — so anything the surface held in a local is gone. This is the state loss that
  // mattered most and it's the *common* path: type a query, get rows, want the expert
  // detail on them, raise the mode. The level change is most often triggered at
  // exactly that moment, on exactly those results.
  describe("query survives a re-mount", () => {
    beforeEach(() => {
      location.hash = "#/truffle";
    });

    it("records the query in the hash on search", async () => {
      const d = await truffleSurface.mount(host, ctxAt("standard"));
      await settle();
      search(host, "nvidia h100");
      await settle();
      expect(readHashParam("q")).toBe("nvidia h100");
      d.dispose();
    });

    it("restores and re-runs the query at the new level", async () => {
      // The whole point: the same query, re-executed, now rendering expert detail.
      // Restoring the text into the box without re-running it would be worse than
      // nothing — a filled search box above someone else's results.
      const first = await truffleSurface.mount(host, ctxAt("standard"));
      await settle();
      search(host, "nvidia h100");
      await settle();
      expect(host.querySelectorAll(".truffle-row").length).toBeGreaterThan(0);
      expect(host.querySelector(".truffle-detail")).toBeNull();

      // What the shell does on a level change.
      first.dispose();
      host.innerHTML = "";
      const second = await truffleSurface.mount(host, ctxAt("expert"));
      await settle();

      expect(host.querySelector<HTMLInputElement>(".truffle-q")!.value).toBe("nvidia h100");
      expect(host.querySelectorAll(".truffle-row").length).toBeGreaterThan(0);
      expect(host.querySelector(".truffle-detail")).not.toBeNull();
      second.dispose();
    });

    it("clears the hash when the query is emptied", async () => {
      // Otherwise a stale query would be resurrected on the next mount, after the
      // user had deliberately cleared it.
      const d = await truffleSurface.mount(host, ctxAt("standard"));
      await settle();
      search(host, "nvidia h100");
      await settle();
      search(host, "");
      await settle();
      expect(readHashParam("q")).toBeNull();
      d.dispose();
    });
  });

  it("cleans up at every level", async () => {
    for (const level of ["guided", "standard", "expert"] as const) {
      host.innerHTML = "";
      const d = await truffleSurface.mount(host, ctxAt(level));
      await settle();
      d.dispose();
      // The shell disposes on every level change, so a leaked node here would
      // stack up a duplicate surface each time the user touched the control.
      expect(host.querySelector(".truffle-surface"), level).toBeNull();
      expect(host.querySelector(".guided-picker"), level).toBeNull();
    }
  });
});
