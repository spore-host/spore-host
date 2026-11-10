// The portal shell: top bar, skip link, router, focus, titles, aria-current,
// live regions and the session-expiry banner (brief §3, §7; #683).
//
// On every navigation the router: applies the saved disclosure level (the
// only place that happens, so the Settings switch takes effect on the NEXT
// navigation); resolves the route; renders it into #page; sets
// document.title to "<Page> — spore.host"; marks the nav entry with
// aria-current; and moves focus to the page h1. It does not move focus on the
// first load, so the skip link stays the first Tab stop.
import { h, replace } from "../components/dom.js";
import { levelForNavigation } from "../lib/disclosure.js";
import { hashPath } from "../lib/hashstate.js";
import type { SessionController } from "../lib/session.js";
import { notFoundPage, settingsPage, signInGate, stubPage } from "../pages/pages.js";
import type { PageContext } from "../pages/templates.js";
import { announce } from "./announce.js";
import { announcement, sessionAlert, type SessionAlert } from "./session-alert.js";
import { documentTitle, homeFor, resolve, type RouteDef } from "./routes.js";
import { topBar } from "./topbar.js";

export interface ShellDeps {
  session: SessionController;
  /** Sign in again without leaving the page. Slice 1 (#684) supplies the popup flow. */
  reauth: () => void;
  root?: Document;
}

export interface Shell {
  /** Render the current hash and start listening for navigation. */
  start(): void;
  /** Re-render the current route (used after sign-in or sign-out). */
  refresh(): void;
  stop(): void;
}

export function createShell({ session, reauth, root = document }: ShellDeps): Shell {
  const header = root.getElementById("topbar-slot")!;
  const main = root.getElementById("main")!;
  const banner = root.getElementById("banner")!;
  const page = root.getElementById("page")!;
  const skip = root.querySelector<HTMLAnchorElement>(".skip-link")!;

  const bar = topBar({
    onSignOut: () => {
      session.clear();
      announce("You've signed out.");
      navigate("/", { focus: true });
    },
  });
  header.replaceWith(bar.el);

  // The skip link targets #main, but in a hash-routed app following it would
  // be read as a route. Move focus instead.
  skip.addEventListener("click", (e) => {
    e.preventDefault();
    main.focus();
  });

  let alertHandle: SessionAlert | null = null;
  let alertTimer: ReturnType<typeof setInterval> | null = null;

  function clearBanner(): void {
    if (alertTimer) clearInterval(alertTimer);
    alertTimer = null;
    alertHandle = null;
    replace(banner);
  }

  const offExpiry = session.onExpiry((e) => {
    clearBanner();
    alertHandle = sessionAlert(e, reauth);
    replace(banner, alertHandle.el);
    announce(announcement(e), { assertive: true });
    if (e.state === "warning") alertTimer = setInterval(() => alertHandle?.tick(), 15000);
  });

  const offSignIn = session.onSignInChange((signedIn) => {
    if (!signedIn) clearBanner();
    renderBar();
  });

  function renderBar(): void {
    bar.render({ signedIn: session.signedIn, accountId: session.accountId, region: session.region });
  }

  function navigate(path: string, opts: { focus: boolean }): void {
    if (hashPath() === path) render(opts);
    else location.hash = `#${path}`;
  }

  function pageFor(route: RouteDef, ctx: PageContext): HTMLElement {
    if (route.id === "not-found") return notFoundPage(ctx);
    if (route.auth === "signed-in" && !ctx.signedIn) return signInGate(route);
    if (route.id === "settings") return settingsPage(session.region);
    return stubPage(route, ctx);
  }

  function render({ focus }: { focus: boolean }): void {
    const level = levelForNavigation();
    root.documentElement.dataset.level = level;
    const path = hashPath();
    // The landing route depends on sign-in: Welcome when signed out, Instances when signed in.
    if (path === "/" && session.signedIn) {
      history.replaceState(history.state, "", `${location.pathname}${location.search}#${homeFor(true)}`);
      return render({ focus });
    }
    const { route, params } = resolve(path);
    const ctx: PageContext = { title: route.title, params, signedIn: session.signedIn, cli: route.cli };
    const el = pageFor(route, ctx);
    el.dataset.routeId = route.id;
    replace(page, el);
    root.title = documentTitle(route.title);
    bar.setCurrent(route);
    if (focus) {
      window.scrollTo(0, 0);
      page.querySelector<HTMLElement>("h1")?.focus();
    }
  }

  // Only `#/…` is a route. A bare fragment (`#main` from a no-JS skip link) is left alone.
  const onHash = () => {
    if (location.hash === "" || location.hash.startsWith("#/")) render({ focus: true });
  };

  return {
    start() {
      renderBar();
      window.addEventListener("hashchange", onHash);
      render({ focus: false });
    },
    refresh() {
      renderBar();
      render({ focus: false });
    },
    stop() {
      window.removeEventListener("hashchange", onHash);
      offExpiry();
      offSignIn();
      clearBanner();
    },
  };
}

/** The static frame index.html provides. Exported so unit tests build the same DOM. */
export function frame(): HTMLElement[] {
  return [
    h("a", { href: "#main", class: "skip-link", data: { control: "chrome.skip-link" } }, "Skip to content"),
    h("div", { id: "topbar-slot" }),
    h("main", { id: "main", tabindex: "-1" }, h("div", { id: "banner", class: "banner-slot" }), h("div", { id: "page" })),
    h("div", { id: "announce-polite", class: "visually-hidden", role: "status", "aria-live": "polite" }),
    h("div", { id: "announce-assertive", class: "visually-hidden", role: "alert" }),
  ];
}
