// The shell's two live regions (brief §7 SC 4.1.3): one persistent polite
// status region and one assertive alert region, both in index.html from first
// paint so screen readers have registered them before anything is said.
//
// Pages call announce("Instance launched") with a short summary. Nothing else
// in the portal is a live region: never a whole list, never a countdown.

export const POLITE_ID = "announce-polite";
export const ASSERTIVE_ID = "announce-assertive";

function region(id: string, assertive: boolean): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    // Only reached outside index.html (unit tests, the gallery page).
    el = document.createElement("div");
    el.id = id;
    el.className = "visually-hidden";
    el.setAttribute("role", assertive ? "alert" : "status");
    if (!assertive) el.setAttribute("aria-live", "polite");
    document.body.append(el);
  }
  return el;
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Say `message` once. Polite by default; `assertive` for session expiry and
 * launch/terminate failures only. The region is cleared first and filled a
 * tick later, so the same message twice is announced twice.
 */
export function announce(message: string, opts: { assertive?: boolean } = {}): void {
  const id = opts.assertive ? ASSERTIVE_ID : POLITE_ID;
  const el = region(id, Boolean(opts.assertive));
  const t = pending.get(id);
  if (t) clearTimeout(t);
  el.textContent = "";
  pending.set(
    id,
    setTimeout(() => {
      el.textContent = message;
      pending.delete(id);
    }, 50),
  );
}
