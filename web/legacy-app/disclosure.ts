// Progressive disclosure: one portal-wide control from "anyone's mom could use
// this" out to "space shuttle cockpit".
//
// Three levels, and ONE global setting rather than per-surface. A per-surface
// level would silently change meaning as the user navigates — they'd set
// "expert" on the instance list, move to costs, and find themselves back in a
// simplified view with no indication why. One setting, shown in the header, is
// the whole state.
//
// The levels are ordered, so a surface asks "am I at least standard?" rather
// than switching on an exact value. That matters for adding a fourth level
// later: `atLeast(level, "standard")` keeps working, whereas
// `level === "standard" || level === "expert"` silently excludes it.

export type DisclosureLevel = "guided" | "standard" | "expert";

/** Ordered least- to most-revealing. Index is the comparison key. */
export const LEVELS: readonly DisclosureLevel[] = ["guided", "standard", "expert"] as const;

/**
 * What the header control is called, wherever anything refers the user to it.
 *
 * One constant because the name has already drifted once: the control was labelled
 * "Detail", two surfaces told the user so in a warning, and renaming it to "Mode" left
 * lagotto and terminal pointing at a control that no longer existed. Someone told a
 * running SSM session ends when they touch X needs X to be findable.
 */
export const LEVEL_CONTROL_NAME = "Mode";

/** Human labels + one line of what each level is FOR, shown in the picker. */
export const LEVEL_INFO: Record<DisclosureLevel, { label: string; blurb: string }> = {
  guided: {
    label: "Guided",
    blurb: "Pick what you're doing; we choose the machine and show the cost.",
  },
  standard: {
    label: "Standard",
    blurb: "Choose the instance type, spot, and how long it lives.",
  },
  expert: {
    label: "Expert",
    blurb: "Everything: AZ, quotas, placement, tags, the raw spec.",
  },
};

/**
 * True when `level` is at or above `min`.
 *
 * The single place levels are compared. Surfaces must not each invent a policy —
 * that's how one surface ends up treating "guided" as "hide the whole thing" and
 * another as "show a simplified version", which reads to the user as the control
 * being broken.
 */
export function atLeast(level: DisclosureLevel, min: DisclosureLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(min);
}

/** Exported so tests assert against the real key rather than a copied literal. */
export const STORAGE_KEY = "spore.disclosure";

/**
 * The default for a first-time or signed-out visitor.
 *
 * Deliberately `guided`, not `standard`. If the default were `standard`, the mode
 * built for the least-experienced user would be the one they never see — they'd
 * have to know it existed and go looking for it, which is precisely the knowledge
 * they don't have.
 */
export const DEFAULT_LEVEL: DisclosureLevel = "guided";

/**
 * Read the remembered level from localStorage.
 *
 * localStorage is right here and wrong for credentials: this is a UI preference,
 * not a secret, and it should survive a reload the way any preference does. (The
 * session's AWS creds stay in memory only — see `session.ts`.)
 *
 * A storage failure returns the default rather than throwing. Safari's private
 * mode and a blocked-cookies configuration both make localStorage throw on
 * access, and a portal that fails to load because it couldn't read a preference
 * is a worse outcome than one that starts in guided mode.
 */
export function loadLevel(storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): DisclosureLevel {
  try {
    const v = storage?.getItem(STORAGE_KEY);
    return isLevel(v) ? v : DEFAULT_LEVEL;
  } catch {
    return DEFAULT_LEVEL;
  }
}

/** Persist the level. Silently tolerates unavailable storage, as above. */
export function saveLevel(
  level: DisclosureLevel,
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, level);
  } catch {
    // A preference that can't be remembered is a small loss; a thrown error
    // during a click handler is a broken control.
  }
}

export function isLevel(v: unknown): v is DisclosureLevel {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
