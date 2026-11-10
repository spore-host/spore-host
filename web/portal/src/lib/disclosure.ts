// How much of the portal to show: `basic` or `advanced` (owner decision D3).
//
// Rebuilt from legacy-app/disclosure.ts, which had three levels, a header
// radio group, links that flipped the level, and a change that re-mounted the
// current page (ending live terminals and watches). What is kept is the ordered
// comparison, so `atLeast()` stays correct if a third level is ever added.
//
// The one control is the Settings switch. A change is SAVED immediately and
// APPLIED on the next navigation: the router calls `levelForNavigation()` as
// it renders a route, and every page reads `appliedLevel()`. Nothing re-renders
// the page the user is on, so a switch can never tear down live state.

/** Ordered from least to most revealed. Add a level by inserting it in order. */
export const LEVELS = ["basic", "advanced"] as const;

export type DisclosureLevel = (typeof LEVELS)[number];

/** Off by default: a first visit is basic. */
export const DEFAULT_LEVEL: DisclosureLevel = "basic";

/** localStorage key. New name, so a stale legacy value ("guided", "expert") is never read. */
export const STORAGE_KEY = "spore.portal.level";

type Store = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Storage can throw (blocked cookies, sandboxed iframes). Fall back to the default level.
    return null;
  }
}

export function isLevel(v: unknown): v is DisclosureLevel {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

/** True when `level` reveals at least as much as `min`. Use this, never `===`. */
export function atLeast(level: DisclosureLevel, min: DisclosureLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(min);
}

/** The saved preference, or the default when unset, unreadable or unrecognised. */
export function loadLevel(store: Store | null = defaultStore()): DisclosureLevel {
  try {
    const v = store?.getItem(STORAGE_KEY);
    return isLevel(v) ? v : DEFAULT_LEVEL;
  } catch {
    return DEFAULT_LEVEL;
  }
}

/** Save the preference. It does not change the applied level; the next navigation does. */
export function saveLevel(level: DisclosureLevel, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(STORAGE_KEY, level);
  } catch {
    // Not persisted, which is the same outcome as a private window. Nothing to tell the user.
  }
}

let applied: DisclosureLevel = DEFAULT_LEVEL;

/**
 * Read the saved preference and make it the applied level. Only the router
 * calls this, once per navigation, which is what "applied on the next
 * navigation" means.
 */
export function levelForNavigation(store: Store | null = defaultStore()): DisclosureLevel {
  applied = loadLevel(store);
  return applied;
}

/** The level the current page was rendered at. */
export function appliedLevel(): DisclosureLevel {
  return applied;
}
