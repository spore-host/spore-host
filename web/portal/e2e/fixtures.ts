// Shared Playwright fixtures and the list of states every gate visits.
//
// No AWS: every request to an AWS endpoint, the spore.host API or the sign-in
// service is aborted, and a test that attempted one fails.
import { test as base, expect, type Page } from "@playwright/test";
import { ROUTES } from "../src/shell/routes.js";

const BLOCKED = /amazonaws\.com|api\.spore\.host|globus\.org|lambda-url/;

export const test = base.extend<{ blocked: string[] }>({
  blocked: async ({}, use) => {
    await use([]);
  },
  context: async ({ context, blocked }, use) => {
    // On the context, so every page a test opens is covered.
    await context.route(BLOCKED, (route) => {
      blocked.push(route.request().url());
      return route.abort();
    });
    await use(context);
  },
  page: async ({ page, blocked }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await use(page);
    expect(blocked, "the portal tried to reach AWS or the API").toEqual([]);
    expect(errors, "uncaught page errors").toEqual([]);
  },
});

export { expect };

export type Auth = "signed-out" | "signed-in";
export type Level = "basic" | "advanced";

export interface State {
  name: string;
  /** Path under the preview server, e.g. "/index.html?state=signed-in#/instances". */
  url: string;
  level: Level;
  auth: Auth;
  route: string;
}

/** A concrete hash path for a route pattern. */
function concrete(path: string): string {
  return path.replace(":id", path.startsWith("/watches") ? "w-0abc123" : "i-0123456789abcdef0");
}

export function appUrl(hash: string, opts: { auth?: Auth; expiry?: "warning" | "expired" } = {}): string {
  const q = new URLSearchParams();
  if (opts.auth === "signed-in") q.set("state", "signed-in");
  if (opts.expiry) q.set("expiry", opts.expiry);
  const qs = q.toString();
  return `/index.html${qs ? `?${qs}` : ""}#${hash}`;
}

/** Every route x sign-in state x level, plus 404 and the two expiry states. */
export function appStates(): State[] {
  const states: State[] = [];
  const paths = [...ROUTES.map((r) => ({ id: r.id, path: concrete(r.path) })), { id: "not-found", path: "/no-such-page" }];
  for (const { id, path } of paths) {
    for (const auth of ["signed-out", "signed-in"] as const) {
      for (const level of ["basic", "advanced"] as const) {
        states.push({ name: `${id} ${auth} ${level}`, url: appUrl(path, { auth }), level, auth, route: path });
      }
    }
  }
  for (const expiry of ["warning", "expired"] as const) {
    for (const level of ["basic", "advanced"] as const) {
      states.push({ name: `instances expiry-${expiry} ${level}`, url: appUrl("/instances", { auth: "signed-in", expiry }), level, auth: "signed-in", route: "/instances" });
    }
  }
  return states;
}

/** Open a state with its disclosure level preset, and wait for the page to render. */
export async function open(page: Page, s: { url: string; level?: Level }): Promise<void> {
  await page.addInitScript((level) => {
    try {
      localStorage.setItem("spore.portal.level", level);
    } catch {
      /* storage blocked: the default level applies */
    }
  }, s.level ?? "basic");
  // A URL that differs only in its hash would not reload the document, so
  // menus, timers and the applied level would leak from the previous state.
  if (page.url() !== "about:blank") await page.goto("about:blank");
  await page.goto(s.url);
  await page.locator("main h1").first().waitFor();
  if (s.url.includes("state=signed-in")) await page.locator("[data-control='chrome.account-menu']").first().waitFor({ state: "attached" });
  if (s.url.includes("expiry=")) await page.locator(".session-alert").waitFor();
}

export const GALLERY = "/gallery.html";
export const SELFTEST = "/selftest.html";

/** Gallery states: the page, and each dialog open. */
export const GALLERY_STATES: { name: string; act?: (p: Page) => Promise<void> }[] = [
  { name: "gallery" },
  { name: "gallery terminate dialog", act: (p) => p.locator("[data-control='gallery.open-terminate']").click() },
  { name: "gallery stop dialog", act: (p) => p.locator("[data-control='gallery.open-stop']").click() },
  {
    name: "gallery details open",
    act: async (p) => {
      for (const s of await p.locator("details summary").all()) await s.click();
    },
  },
];

/** Shell states that only exist after an interaction. */
export const SHELL_INTERACTIONS: { name: string; width: number; act: (p: Page) => Promise<void> }[] = [
  { name: "account menu open", width: 1280, act: (p) => p.locator("[data-control='chrome.account-menu']").click() },
  { name: "narrow menu open", width: 320, act: (p) => p.locator("[data-control='chrome.menu']").click() },
  {
    name: "narrow menu and account menu open",
    width: 320,
    act: async (p) => {
      await p.locator("[data-control='chrome.menu']").click();
      await p.locator("[data-control='chrome.account-menu']").click();
    },
  },
];
