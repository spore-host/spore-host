// The guided Instances surface, and specifically the one thing about it that can
// break silently and expensively.
//
// Guided mode hides the Dashboard's own launch/sweep/queue forms with a CSS rule
// (`.guided-instances .dash-section.launch` et al.) that targets class names living
// inside @spore-host/spawn-ts — a separately versioned package this repo consumes
// prebuilt. Nothing in either repo couples the two, so a refactor of the Dashboard's
// markup un-hides the full 14-field launch form for beginners, in a mode whose whole
// promise is that you can't hurt yourself. No test failure, no type error, no visual
// change in any mode a developer is ever in.
//
// So the selectors are read out of the stylesheet rather than restated here: this
// asserts the *coupling*, not a copy of it. A selector that matches nothing is the
// signal that spawn-ts moved.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../session.js";
import type { PortalConfig, SurfaceContext } from "./types.js";
import type { DisclosureLevel } from "../disclosure.js";

// Swap the real EC2 provider for spawn-ts's own MockProvider. Mounting this surface
// constructs an EC2Provider and calls client.startMonitor(), which issues
// DescribeInstances immediately — and the AWS SDK in Node uses its own HTTP handler,
// not globalThis.fetch, so stubbing fetch does NOT intercept it. Without this mock
// the suite makes real unauthenticated calls to AWS, and the run reports an unhandled
// `AuthFailure` rejection whenever it lasts long enough for the response to land.
// (It passes in isolation either way — the run is too short. The full suite is where
// it shows, which is why the fetch stub this replaces looked like it worked.)
//
// Mocked at the module boundary rather than by injection because the provider is
// constructed inside mount() and the surface takes no provider argument. Nothing
// here asserts on instance data, so an empty mock world is enough.
vi.mock("@spore-host/spawn-ts", async (importActual) => {
  const actual = await importActual<typeof import("@spore-host/spawn-ts")>();
  return { ...actual, EC2Provider: actual.MockProvider };
});

const { instancesSurface } = await import("./instances.js");

const settle = () => new Promise((r) => setTimeout(r, 50));

const config = { region: "us-east-1" } as PortalConfig;

// Resolved from the vitest root (web/), not import.meta.url: under Vite's transform
// import.meta.url is not a file: URL.
const CSS = readFileSync(resolve(process.cwd(), "css/style.css"), "utf8");

/**
 * The `.guided-instances …` selectors the stylesheet hides, pulled from the rule
 * itself so this test tracks the CSS instead of duplicating it.
 */
function hiddenSelectors(): string[] {
  const rule = /((?:\s*\.guided-instances[^,{]+,?)+)\{\s*display:\s*none/.exec(CSS);
  if (!rule) throw new Error("no `.guided-instances … { display: none }` rule in style.css");
  return rule[1]!
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ctxAt(level: DisclosureLevel): SurfaceContext {
  const session = new SessionController("us-east-1", null);
  session.setLevel(level);
  // The surface throws without creds. These are the AWS docs' example key, and they
  // never reach AWS — the provider is MockProvider (see vi.mock above).
  vi.spyOn(session, "getCreds").mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "token",
  } as never);
  return { session, config, level, navigate: vi.fn() };
}

describe("instancesSurface disclosure", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("marks the host so the stylesheet can hide the Dashboard's forms at guided", async () => {
    const d = await instancesSurface.mount(host, ctxAt("guided"));
    await settle();
    expect(host.classList.contains("guided-instances")).toBe(true);
    d.dispose();
    // And removes it, or a level change would leave the class on a host that then
    // mounts the standard view — hiding the launch form with no way to get it back.
    expect(host.classList.contains("guided-instances")).toBe(false);
  });

  it("every selector the stylesheet hides still matches a rendered node", async () => {
    // The load-bearing assertion. If spawn-ts renames `.dash-section.launch`, this
    // fails here rather than shipping an un-hidden launch form to beginners.
    const d = await instancesSurface.mount(host, ctxAt("guided"));
    await settle();

    const selectors = hiddenSelectors();
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) {
      // Scoped to the host, which carries .guided-instances, so the full selector
      // resolves exactly as it does in the browser.
      expect(document.querySelectorAll(sel).length, `${sel} matched nothing`).toBeGreaterThan(0);
    }
    d.dispose();
  });

  it("hides the launch form but KEEPS the instance list at guided", async () => {
    // The one simplification that would cost real money: a beginner who can start an
    // instance and then can't see or stop it. The list, meters and log stay.
    const d = await instancesSurface.mount(host, ctxAt("guided"));
    await settle();

    const launch = document.querySelector(".guided-instances .dash-section.launch");
    expect(launch, "the Dashboard's launch section should still be in the DOM").not.toBeNull();
    // Hidden by the stylesheet, which happy-dom doesn't apply — so assert the
    // selector matches (above) and that the section we must NOT hide is untargeted.
    const hidden = hiddenSelectors();
    const list = [...document.querySelectorAll(".dash-section")].filter(
      (el) => !hidden.some((sel) => el.matches(sel.replace(".guided-instances ", ""))),
    );
    expect(list.length, "no Dashboard sections left visible at guided").toBeGreaterThan(0);
    d.dispose();
  });

  it("mounts the guided picker above the Dashboard at guided", async () => {
    const d = await instancesSurface.mount(host, ctxAt("guided"));
    await settle();
    expect(host.querySelectorAll(".guided-card").length).toBeGreaterThan(0);
    d.dispose();
  });

  it("leaves the Dashboard untouched from standard up", async () => {
    for (const level of ["standard", "expert"] as const) {
      host.innerHTML = "";
      host.className = "";
      const d = await instancesSurface.mount(host, ctxAt(level));
      await settle();
      expect(host.classList.contains("guided-instances"), level).toBe(false);
      expect(host.querySelector(".guided-card"), level).toBeNull();
      expect(host.querySelector(".dash-section.launch"), level).not.toBeNull();
      d.dispose();
    }
  });
});
