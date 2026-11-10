// Page state in the URL hash query, so it survives a reload and can be shared.
//
// Ported unchanged in behaviour from legacy-app/hashstate.ts (brief §9 reuse
// table). Writes use history.replaceState, which does NOT fire `hashchange`
// in browsers, so a page recording its own state never re-routes itself.

/** The query on a hash route: `#/types?q=gpu` gives `q=gpu`. */
export function readHashParams(hash: string = location.hash): URLSearchParams {
  const q = hash.indexOf("?");
  return new URLSearchParams(q === -1 ? "" : hash.slice(q + 1));
}

/** One param from the current hash route, or null. */
export function readHashParam(key: string, hash: string = location.hash): string | null {
  return readHashParams(hash).get(key);
}

/** The path part of a hash route, without the leading `#` or the query: `#/instances/i-1?x=1` gives `/instances/i-1`. */
export function hashPath(hash: string = location.hash): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  return path === "" ? "/" : path;
}

/**
 * Merge `patch` into the current hash query and replace the history entry.
 * A null or empty value removes the key, so a cleared field leaves a clean URL.
 * replaceState, not pushState: typing is not navigation.
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
  history.replaceState(history.state, "", `${location.pathname}${location.search}${path}${qs ? `?${qs}` : ""}`);
}
