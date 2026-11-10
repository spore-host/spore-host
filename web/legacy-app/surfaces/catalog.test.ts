// The catalog surface, and specifically the one state that used to be unreachable:
// signed out.
//
// This surface was `requiresAuth: true` purely because the API's endpoint sat behind
// the Lambda's auth check — not because the data is per-account. It isn't: the handler
// takes no arguments and returns a fixed five-element list. Now that the endpoint is
// anonymous, the surface mounts for visitors with no credentials, and that path has
// two ways to break that a signed-in developer would never see:
//
//   1. `getCreds()` returns null and building the credentials header throws, so the
//      request never leaves the page.
//   2. A 401 is reported as "authentication failed", sending a signed-out reader to a
//      sign-in screen that cannot help them — the endpoint doesn't authenticate.
//
// Both are asserted below against a stubbed fetch, since nothing here needs the real
// API and a test that reached api.spore.host would be a live network call in CI.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../session.js";
import type { PortalConfig, SurfaceContext } from "./types.js";
import type { DisclosureLevel } from "../disclosure.js";
import { catalogSurface } from "./catalog.js";
import { surfaces } from "./registry.js";

const settle = () => new Promise((r) => setTimeout(r, 0));

const config = { region: "us-east-1", apiBase: "https://api.example.invalid" } as PortalConfig;

const FORMATIONS = [
  { name: "r-research@2024.03", display_name: "R + Quarto", description: "R 4.3, tidyverse" },
  { name: "python-ml@2024.03", display_name: "Python ML", description: "PyTorch, sklearn" },
];

/** A context with no credentials — the signed-out visitor. */
function signedOutCtx(level: DisclosureLevel = "guided"): SurfaceContext {
  const session = new SessionController("us-east-1", null);
  session.setLevel(level);
  return { session, config, level, navigate: vi.fn() };
}

/** A context whose session has credentials. */
function signedInCtx(level: DisclosureLevel = "standard"): SurfaceContext {
  const ctx = signedOutCtx(level);
  vi.spyOn(ctx.session, "getCreds").mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "token",
  } as never);
  return ctx;
}

describe("catalogSurface without a session", () => {
  let host: HTMLElement;
  const realFetch = globalThis.fetch;
  let calls: Array<{ url: string; headers: Record<string, string> }>;

  /** Stub fetch with a fixed status/body and record what was sent. */
  function stubFetch(status: number, body: unknown): void {
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("is registered as not requiring auth, so the shell mounts it for a visitor", () => {
    // The shell gates on the *registry* entry (shell.ts: `surface.requiresAuth &&
    // !signedIn` → sign-in gate), not on the surface module. If these two ever
    // disagree, the surface's own `requiresAuth: false` is dead and the visitor still
    // hits a wall — so assert the entry the shell actually reads.
    expect(surfaces.find((s) => s.id === "catalog")?.requiresAuth).toBe(false);
    expect(catalogSurface.requiresAuth).toBe(false);
  });

  it("mounts and loads with no credentials at all", async () => {
    stubFetch(200, { success: true, formations: FORMATIONS });
    const d = await catalogSurface.mount(host, signedOutCtx());
    await settle();
    await settle();

    expect(calls.length, "no request was made").toBe(1);
    expect(host.querySelectorAll(".catalog-card").length).toBe(2);
    expect(host.textContent).toContain("R + Quarto");
    d.dispose();
  });

  it("omits the credentials header when there are none, rather than throwing", async () => {
    // The failure this pins: `credentialsHeader(creds!)` on a null cred object throws
    // synchronously inside load(), so the request is never sent and the surface sits
    // on "loading…" forever with no error shown.
    stubFetch(200, { success: true, formations: FORMATIONS });
    const d = await catalogSurface.mount(host, signedOutCtx());
    await settle();
    await settle();

    expect(calls[0]!.headers["X-AWS-Credentials"]).toBeUndefined();
    expect(host.querySelector(".catalog-status")?.textContent ?? "").not.toContain("loading");
    d.dispose();
  });

  it("still sends the credentials header when signed in", async () => {
    // Not required by the endpoint, but dropping it unconditionally would be a
    // separate change to a header other surfaces rely on for the same API.
    stubFetch(200, { success: true, formations: FORMATIONS });
    const d = await catalogSurface.mount(host, signedInCtx());
    await settle();
    await settle();

    expect(calls[0]!.headers["X-AWS-Credentials"]).toBeTruthy();
    d.dispose();
  });

  it("does not blame authentication for a 401", async () => {
    // A 401 from an endpoint that doesn't authenticate means the deployed API is older
    // than this page. Telling a signed-out reader "authentication failed" points them
    // at a sign-in that cannot fix it.
    stubFetch(401, { success: false, error: "authentication failed" });
    const d = await catalogSurface.mount(host, signedOutCtx());
    await settle();
    await settle();

    const status = host.querySelector(".catalog-status")!;
    expect(status.classList.contains("error")).toBe(true);
    expect(status.textContent!.toLowerCase()).not.toContain("authentication");
    expect(status.textContent!.toLowerCase()).not.toContain("sign in");
    d.dispose();
  });

  it("reports a non-401 failure without claiming the catalog is empty", async () => {
    stubFetch(500, { success: false, error: "boom" });
    const d = await catalogSurface.mount(host, signedOutCtx());
    await settle();
    await settle();

    const status = host.querySelector(".catalog-status")!;
    expect(status.textContent).toContain("500");
    expect(host.querySelectorAll(".catalog-card").length).toBe(0);
    d.dispose();
  });

  it("escapes formation fields rather than injecting them", async () => {
    stubFetch(200, {
      success: true,
      formations: [
        { name: "x@1", display_name: "<img src=x onerror=alert(1)>", description: "d" },
      ],
    });
    const d = await catalogSurface.mount(host, signedOutCtx());
    await settle();
    await settle();

    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
    d.dispose();
  });
});
