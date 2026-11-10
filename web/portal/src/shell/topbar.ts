// TopBar with Menu, and AccountMenu (brief §3 "Navigation rules", §5).
//
// No sidebar at any width. Below 720 px everything after the logo folds into
// a Menu button with aria-expanded (SC 1.4.10). The primary action, Launch an
// instance, is a button in the bar, not a nav tab. There is no level control
// here: the only switch is in Settings (D3).
//
// Both menus are disclosure buttons, not ARIA menus: a list of links and one
// button needs no roving focus, and role=menu would promise arrow-key
// behaviour this does not need. Escape closes either and returns focus to its
// button.
import { h, icon, replace, uid } from "../components/dom.js";
import { accountLabel } from "../lib/format.js";
import { regionName } from "../lib/regions.js";
import { ROUTES, type RouteDef } from "./routes.js";
import logoUrl from "../../../assets/brand/spore-host-logo-header.png";

export interface TopBarState {
  signedIn: boolean;
  accountId: string | null;
  region: string;
}

export interface TopBar {
  el: HTMLElement;
  render(state: TopBarState): void;
  /** Mark the nav entry for `route` with aria-current, and close any open menu. */
  setCurrent(route: RouteDef): void;
  closeMenus(): void;
}

function navRoutes(signedIn: boolean): RouteDef[] {
  return ROUTES.filter((r) => r.nav && (r.stubFor === undefined || r.navWhenStub)).filter((r) => signedIn || r.auth !== "signed-in");
}

/** Wire a disclosure button to a panel. Returns a close function. */
function disclosure(btn: HTMLButtonElement, panel: HTMLElement, onToggle?: (open: boolean) => void): () => void {
  const set = (open: boolean) => {
    btn.setAttribute("aria-expanded", String(open));
    panel.dataset.open = String(open);
    onToggle?.(open);
  };
  btn.addEventListener("click", () => set(btn.getAttribute("aria-expanded") !== "true"));
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") {
      e.stopPropagation();
      set(false);
      btn.focus();
    }
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") {
      e.stopPropagation();
      set(false);
    }
  });
  set(false);
  return () => set(false);
}

export function topBar(opts: { onSignOut: () => void }): TopBar {
  const el = h("header", { class: "topbar" });
  let closers: (() => void)[] = [];
  let current: RouteDef | null = null;

  function accountMenu(state: TopBarState): HTMLElement {
    const panelId = uid("account-panel");
    const btn = h(
      "button",
      { type: "button", class: "btn btn-secondary account-toggle", "aria-controls": panelId, data: { control: "chrome.account-menu" } },
      "Account",
      icon("chevron"),
    );
    const location = regionName(state.region);
    const panel = h(
      "div",
      { id: panelId, class: "account-panel" },
      h("p", { class: "account-label" }, state.accountId ? accountLabel(state.accountId) : "Your AWS account"),
      h("p", { class: "account-location" }, location ? `Location: ${location}` : "Location: not named"),
      h(
        "ul",
        { class: "account-links" },
        h("li", {}, h("a", { href: "#/settings", class: "account-link", data: { control: "chrome.settings" } }, "Settings")),
        h(
          "li",
          {},
          h("button", { type: "button", class: "btn btn-link account-link", data: { control: "chrome.sign-out" }, on: { click: () => opts.onSignOut() } }, "Sign out"),
        ),
      ),
    );
    const close = disclosure(btn, panel);
    closers.push(close);
    // Close when focus leaves the menu, so an open panel never hides what Tab reaches next.
    const wrap = h("div", { class: "account-menu" }, btn, panel);
    wrap.addEventListener("focusout", (e) => {
      if (e.relatedTarget && !wrap.contains(e.relatedTarget as Node)) close();
    });
    return wrap;
  }

  function render(state: TopBarState): void {
    closers = [];
    const panelId = "topbar-panel";
    const toggle = h(
      "button",
      { type: "button", class: "btn btn-secondary topbar-menu-toggle", "aria-controls": panelId, data: { control: "chrome.menu" } },
      icon("menu"),
      "Menu",
    );
    const nav = h(
      "nav",
      { class: "topbar-nav", "aria-label": "Main" },
      h(
        "ul",
        { class: "topbar-nav-list" },
        ...navRoutes(state.signedIn).map((r) =>
          h("li", {}, h("a", { href: `#${r.path}`, class: "topbar-nav-link", data: { control: r.navControl, routeId: r.id } }, r.nav!)),
        ),
      ),
    );
    const actions = h(
      "div",
      { class: "topbar-actions" },
      state.signedIn
        ? h("a", { href: "#/launch", class: "btn btn-primary", data: { control: "topbar.launch" } }, "Launch an instance")
        : h("a", { href: "#/", class: "btn btn-primary", data: { control: "chrome.sign-in" } }, "Sign in"),
      state.signedIn ? accountMenu(state) : null,
    );
    const panel = h("div", { id: panelId, class: "topbar-panel" }, nav, actions);
    closers.unshift(disclosure(toggle, panel));
    replace(
      el,
      h(
        "div",
        { class: "topbar-inner" },
        h("a", { href: "#/", class: "topbar-logo", data: { control: "chrome.logo" } }, h("img", { src: logoUrl, alt: "spore.host home", width: 195, height: 78 })),
        toggle,
        panel,
      ),
    );
    if (current) setCurrent(current);
  }

  function setCurrent(route: RouteDef): void {
    current = route;
    for (const a of el.querySelectorAll<HTMLAnchorElement>(".topbar-nav-link")) {
      const r = ROUTES.find((x) => x.id === a.dataset.routeId);
      if (!r) continue;
      if (r.id === route.id) a.setAttribute("aria-current", "page");
      else if (r.path !== "/" && route.path.startsWith(`${r.path}/`)) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    }
    closeMenus();
  }

  function closeMenus(): void {
    for (const c of closers) c();
  }

  return { el, render, setCurrent, closeMenus };
}
