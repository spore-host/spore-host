// The Phase 0 pages: a stub for every slice route, the sign-in gate, the
// Settings switch and the 404. No slice feature is built here (#683 scope).
import { checkbox, linkButton } from "../components/controls.js";
import { alert } from "../components/display.js";
import { h } from "../components/dom.js";
import { announce } from "../shell/announce.js";
import { appliedLevel, atLeast, loadLevel, saveLevel } from "../lib/disclosure.js";
import { regionName } from "../lib/regions.js";
import type { RouteDef } from "../shell/routes.js";
import { centredPage, listPage, type PageContext } from "./templates.js";

const ISSUES = "https://github.com/spore-host/spore-host/issues";

/** A slice route that is not built yet. Says so plainly and points at the command line, which works today. */
export function stubPage(route: RouteDef, ctx: PageContext): HTMLElement {
  const issue = route.stubFor!;
  return listPage({
    title: route.title,
    lede: "This page isn't built yet.",
    cli: route.cli,
    body: [
      h(
        "p",
        {},
        "It arrives in a later stage of the rebuild, tracked in ",
        h("a", { href: `${ISSUES}/${issue}`, data: { control: "chrome.issue-link" } }, `issue ${issue}`),
        ".",
      ),
      route.cli ? h("p", {}, "Until then, the command below does the same job on the command line.") : null,
      ctx.params.id ? h("p", { class: "muted" }, "You opened a link to one item on this page.") : null,
    ],
  });
}

/** A signed-in page reached while signed out. Never an empty list (brief §8 finding 4). */
export function signInGate(route: RouteDef): HTMLElement {
  return centredPage({
    title: route.title,
    lede: "You need to sign in to see this page.",
    body: [h("p", {}, linkButton({ label: "Go to the welcome page", href: "#/", control: "chrome.sign-in", variant: "primary" }))],
  });
}

export function notFoundPage(ctx: PageContext): HTMLElement {
  return centredPage({
    title: "We can't find that page",
    lede: "The address may be mistyped, or the page may have moved.",
    body: [
      h(
        "p",
        {},
        ctx.signedIn
          ? linkButton({ label: "Go to instances", href: "#/instances", control: "chrome.not-found-home", variant: "primary" })
          : linkButton({ label: "Go to the welcome page", href: "#/", control: "chrome.not-found-home", variant: "primary" }),
      ),
    ],
  });
}

/** The status line under the switch, which says whether the saved choice is on this page yet. */
export function levelNote(saved: ReturnType<typeof loadLevel>, applied: ReturnType<typeof appliedLevel>): string {
  if (saved === applied) return atLeast(applied, "advanced") ? "Advanced options are on." : "Advanced options are off.";
  return atLeast(saved, "advanced")
    ? "Saved. Advanced options appear on the next page you open."
    : "Saved. Advanced options go away on the next page you open.";
}

/**
 * Settings: the ONE disclosure control (D3). Saving does not re-render this
 * page or any other; the router applies the level on the next navigation.
 */
export function settingsPage(region: string): HTMLElement {
  const note = h("p", { class: "field-hint settings-note", id: "level-note" }, levelNote(loadLevel(), appliedLevel()));
  const location = regionName(region);
  return listPage({
    title: "Settings",
    body: [
      h(
        "section",
        { class: "settings-section", "aria-labelledby": "settings-options" },
        h("h2", { id: "settings-options" }, "Options"),
        checkbox({
          label: "Show advanced options",
          control: "chrome.settings-advanced",
          id: "settings-advanced",
          hint: "Adds more choices to forms and more detail to lists. Everything you see now stays where it is.",
          checked: atLeast(loadLevel(), "advanced"),
          onChange: (on) => {
            saveLevel(on ? "advanced" : "basic");
            note.textContent = levelNote(loadLevel(), appliedLevel());
            announce(note.textContent);
          },
        }),
        note,
      ),
      h(
        "section",
        { class: "settings-section", "aria-labelledby": "settings-location" },
        h("h2", { id: "settings-location" }, "Location"),
        h("p", {}, location ? `New instances launch in ${location}.` : "New instances launch in a location this page can't name yet."),
      ),
      alert({ tone: "info", title: "Light theme only for now", body: h("p", {}, "A dark theme returns once it meets the same contrast standard.") }),
    ],
  });
}
