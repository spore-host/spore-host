// Router, routes, focus, titles, aria-current, announce and the expiry banner,
// on the same DOM frame index.html provides.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTES, documentTitle, homeFor, resolve, SLICES } from "./routes.js";
import { announce, ASSERTIVE_ID, POLITE_ID } from "./announce.js";
import { announcement, sessionAlert, warningTitle } from "./session-alert.js";
import { createShell, frame, type Shell } from "./shell.js";
import { SessionController } from "../lib/session.js";
import { STORAGE_KEY } from "../lib/disclosure.js";

describe("routes", () => {
  it("resolves every route and 404s the rest", () => {
    expect(resolve("/").route.id).toBe("welcome");
    expect(resolve("/instances").route.id).toBe("instances");
    expect(resolve("/instances/").route.id).toBe("instances");
    expect(resolve("/instances/i-0abc").params).toEqual({ id: "i-0abc" });
    expect(resolve("/watches/new").route.id).toBe("watch-new");
    expect(resolve("/watches/w-1").route.id).toBe("watch");
    expect(resolve("/truffle").route.id).toBe("not-found");
    expect(resolve("/instances/a/b").route.id).toBe("not-found");
    expect(resolve("/instances/%E0%A4%A").route.id).toBe("not-found");
  });

  it("uses task words, never tool names, in route paths", () => {
    for (const r of ROUTES) expect(r.path).not.toMatch(/spawn|truffle|lagotto|strata/);
  });

  it("every stub names a slice issue, and slice issues are #684-#689", () => {
    expect(Object.values(SLICES)).toEqual([684, 685, 686, 687, 688, 689]);
    for (const r of ROUTES) if (r.stubFor !== undefined) expect(Object.values(SLICES)).toContain(r.stubFor);
  });

  it("Watches stays out of the nav until slice 6 ships", () => {
    const w = ROUTES.find((r) => r.id === "watches")!;
    expect(w.stubFor).toBe(689);
    expect(w.navWhenStub).toBe(false);
  });

  it("titles pages as '<Page> — spore.host' and lands by sign-in state", () => {
    expect(documentTitle("Instances")).toBe("Instances — spore.host");
    expect(homeFor(true)).toBe("/instances");
    expect(homeFor(false)).toBe("/");
  });
});

describe("announce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("speaks through one polite and one assertive region, re-announcing repeats", () => {
    announce("Saved.");
    announce("Signed out.", { assertive: true });
    vi.advanceTimersByTime(60);
    expect(document.getElementById(POLITE_ID)!.textContent).toBe("Saved.");
    expect(document.getElementById(POLITE_ID)!.getAttribute("role")).toBe("status");
    expect(document.getElementById(ASSERTIVE_ID)!.getAttribute("role")).toBe("alert");
    announce("Saved.");
    expect(document.getElementById(POLITE_ID)!.textContent).toBe("");
    vi.advanceTimersByTime(60);
    expect(document.getElementById(POLITE_ID)!.textContent).toBe("Saved.");
  });
});

describe("session alert", () => {
  it("says the minutes left and never 'session'", () => {
    expect(warningTitle(4)).toBe("You'll be signed out in 4 minutes");
    expect(warningTitle(1)).toBe("You'll be signed out in 1 minute");
    expect(warningTitle(0)).toBe("You'll be signed out in 1 minute");
    const e = { state: "expired" as const, minutesLeft: 0, expiresAt: new Date() };
    expect(announcement(e)).toMatch(/still costing money/);
    expect(announcement(e)).not.toMatch(/session/i);
  });

  it("ticks the minutes silently and offers re-auth", () => {
    const onReauth = vi.fn();
    const exp = Date.now() + 4 * 60000;
    const a = sessionAlert({ state: "warning", minutesLeft: 4, expiresAt: new Date(exp) }, onReauth);
    a.tick(exp - 2 * 60000);
    expect(a.el.querySelector(".alert-title")!.textContent).toBe("You'll be signed out in 2 minutes");
    expect(a.el.getAttribute("aria-live")).toBeNull();
    a.el.querySelector("button")!.click();
    expect(onReauth).toHaveBeenCalled();
  });
});

describe("shell", () => {
  let shell: Shell;
  let session: SessionController;
  const store = new Map<string, string>();

  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    store.clear();
    document.body.replaceChildren(...frame());
    history.replaceState(null, "", "/#/");
    session = new SessionController("us-east-1", { resolveAccount: async () => "123456789012" });
    shell = createShell({ session, reauth: () => {} });
  });

  afterEach(() => {
    shell.stop();
    vi.unstubAllGlobals();
  });

  const signIn = (expMs = Date.now() + 3600_000) => session.adopt({ accessKeyId: "a", secretAccessKey: "b", sessionToken: "c", expiration: new Date(expMs) });
  const go = async (hash: string) => {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await Promise.resolve();
  };

  it("renders Welcome signed out with a title and one h1, without moving focus on first load", () => {
    shell.start();
    expect(document.title).toBe("Welcome — spore.host");
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.activeElement).toBe(document.body);
  });

  it("shows only pages that need no account when signed out", () => {
    shell.start();
    const nav = [...document.querySelectorAll(".topbar-nav-link")].map((a) => a.textContent);
    expect(nav).toEqual(["Instance types", "Help"]);
    expect(document.querySelector("[data-control='topbar.launch']")).toBeNull();
  });

  it("keeps nav order fixed when signed in, without Watches", async () => {
    shell.start();
    await signIn();
    const nav = [...document.querySelectorAll(".topbar-nav-link")].map((a) => a.textContent);
    expect(nav).toEqual(["Instances", "Instance types", "Spending", "Help"]);
    expect(document.querySelector("[data-control='topbar.launch']")!.textContent).toBe("Launch an instance");
    expect(document.querySelector(".account-label")!.textContent).toBe("AWS account ending 9012");
  });

  it("moves focus to the h1 on a route change and sets aria-current", async () => {
    shell.start();
    await signIn();
    await go("#/types");
    expect(document.activeElement?.tagName).toBe("H1");
    expect(document.activeElement?.textContent).toBe("Instance types and prices");
    expect(document.title).toBe("Instance types and prices — spore.host");
    expect(document.querySelector("[data-route-id='types']")!.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector("[data-route-id='instances']")!.hasAttribute("aria-current")).toBe(false);
    await go("#/instances/i-0abc");
    expect(document.querySelector("[data-route-id='instances']")!.getAttribute("aria-current")).toBe("true");
  });

  it("sends a signed-in user from / to Instances", async () => {
    await signIn();
    shell.start();
    expect(location.hash).toBe("#/instances");
    expect(document.title).toBe("Instances — spore.host");
  });

  it("gates signed-in pages behind sign-in instead of showing them empty", () => {
    history.replaceState(null, "", "/#/instances");
    shell.start();
    expect(document.querySelector("h1")!.textContent).toBe("Instances");
    expect(document.body.textContent).toContain("You need to sign in to see this page.");
  });

  it("renders the 404 for an unknown route", async () => {
    shell.start();
    await go("#/nope");
    expect(document.title).toBe("We can't find that page — spore.host");
    expect(document.querySelector("[data-control='chrome.not-found-home']")!.getAttribute("href")).toBe("#/");
  });

  it("ignores a bare fragment such as the skip link's #main", async () => {
    shell.start();
    const before = document.title;
    await go("#main");
    expect(document.title).toBe(before);
  });

  it("skip link focuses main instead of routing", () => {
    shell.start();
    const skip = document.querySelector<HTMLAnchorElement>(".skip-link")!;
    skip.click();
    expect(document.activeElement?.id).toBe("main");
  });

  it("applies the Settings switch on the NEXT navigation, never in place", async () => {
    shell.start();
    await signIn();
    await go("#/settings");
    expect(document.documentElement.dataset.level).toBe("basic");
    const box = document.querySelector<HTMLInputElement>("#settings-advanced")!;
    const page = document.getElementById("page")!.firstElementChild;
    box.click();
    expect(store.get(STORAGE_KEY)).toBe("advanced");
    // Same page element, same level: nothing re-rendered.
    expect(document.getElementById("page")!.firstElementChild).toBe(page);
    expect(document.documentElement.dataset.level).toBe("basic");
    expect(document.getElementById("level-note")!.textContent).toBe("Saved. Advanced options appear on the next page you open.");
    await go("#/types");
    expect(document.documentElement.dataset.level).toBe("advanced");
  });

  it("shows the expiry banner and announces it assertively, once", async () => {
    vi.useFakeTimers();
    shell.start();
    await signIn(Date.now() - 1000);
    vi.advanceTimersByTime(100);
    expect(document.querySelector(".session-alert")!.getAttribute("data-state")).toBe("expired");
    expect(document.getElementById(ASSERTIVE_ID)!.textContent).toMatch(/^You've been signed out\./);
    vi.useRealTimers();
  });

  it("menus are disclosures that Escape closes, returning focus", async () => {
    shell.start();
    await signIn();
    const toggle = document.querySelector<HTMLButtonElement>("[data-control='chrome.account-menu']")!;
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    panel.querySelector<HTMLAnchorElement>("a")!.focus();
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("sign out clears the account and returns to Welcome", async () => {
    shell.start();
    await signIn();
    document.querySelector<HTMLButtonElement>("[data-control='chrome.sign-out']")!.click();
    await go(location.hash);
    expect(session.signedIn).toBe(false);
    expect(document.querySelector(".account-label")).toBeNull();
  });
});
