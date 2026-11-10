// Per-surface state in the URL, so a re-mount doesn't lose it.
//
// A disclosure-level change re-mounts the current surface (that IS the update
// mechanism — surfaces read ctx.level once at mount), and the shell clears
// `.portal-main` to do it. So everything a surface held in a local is gone. The
// worst case is also the common one: type a truffle query, get rows, want the
// expert detail on them, raise the level → empty box, query gone. The level change
// is most often triggered at exactly that moment, on exactly that data.
//
// The URL is the store rather than sessionStorage or a shell-held bag, for three
// reasons: `currentId()` already tolerates a trailing `?query` (it was taught to
// for the Slack OAuth callback), so no shell change is needed; the state becomes
// bookmarkable and shareable for free; and there is one source of truth rather
// than a cache that can disagree with the address bar.
//
// Writes use history.replaceState, which does NOT fire `hashchange` — so a surface
// recording its own state can't trip the router into re-routing underneath itself.
// (Assigning location.hash would.)

/** The query params on the current hash route, e.g. `#/truffle?q=gpu` → `q=gpu`. */
export function readHashParams(hash: string = location.hash): URLSearchParams {
  const q = hash.indexOf("?");
  return new URLSearchParams(q === -1 ? "" : hash.slice(q + 1));
}

/** One param from the current hash route, or null. */
export function readHashParam(key: string, hash: string = location.hash): string | null {
  return readHashParams(hash).get(key);
}

/**
 * Merge `patch` into the current hash route's query and replace the history entry.
 * A null/empty value removes the key, so a cleared search box leaves a clean URL
 * rather than `?q=`.
 *
 * replaceState rather than pushState: a keystroke-by-keystroke search is not
 * navigation, and filling the back button with it would make Back useless on the
 * one surface where the user most wants it.
 */
export function writeHashParams(patch: Record<string, string | null | undefined>): void {
  const hash = location.hash;
  const q = hash.indexOf("?");
  const path = (q === -1 ? hash : hash.slice(0, q)) || "#/";
  const params = readHashParams(hash);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "") params.delete(k);
    else params.set(k, v);
  }
  const qs = params.toString();
  // `location.pathname + location.search` keeps the SPA's own path intact — the
  // portal is served from /app/, and a bare "#…" argument to replaceState is
  // resolved against the current URL anyway, but being explicit survives a future
  // move to a different base path.
  history.replaceState(history.state, "", `${location.pathname}${location.search}${path}${qs ? `?${qs}` : ""}`);
}
