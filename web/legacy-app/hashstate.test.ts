// The state-in-URL helper. Small enough to read at a glance, but three of its
// properties are load-bearing and none of them is obvious from the signature:
// writes must not fire `hashchange` (or a surface recording its own state would
// re-route itself out from under the user), an empty value must remove the key
// rather than write `?q=`, and the route path must survive the query being
// rewritten.
import { beforeEach, describe, expect, it } from "vitest";
import { readHashParam, readHashParams, writeHashParams } from "./hashstate.js";

describe("readHashParams", () => {
  it("reads params from a hash route", () => {
    const p = readHashParams("#/truffle?q=nvidia+h100&days=90");
    expect(p.get("q")).toBe("nvidia h100");
    expect(p.get("days")).toBe("90");
  });

  it("returns empty for a route with no query", () => {
    expect([...readHashParams("#/truffle")]).toEqual([]);
    expect([...readHashParams("")]).toEqual([]);
  });

  it("returns null for an absent key", () => {
    expect(readHashParam("q", "#/truffle?days=7")).toBeNull();
  });
});

describe("writeHashParams", () => {
  beforeEach(() => {
    location.hash = "#/truffle";
  });

  it("round-trips a value through the URL", () => {
    writeHashParams({ q: "nvidia h100" });
    expect(readHashParam("q")).toBe("nvidia h100");
  });

  it("keeps the route path", () => {
    // The path is what the router reads. Rewriting the query must not move the user
    // to a different surface — which is precisely what a naive `location.hash = "?q="`
    // would do.
    writeHashParams({ q: "gpu" });
    expect(location.hash.split("?")[0]).toBe("#/truffle");
  });

  it("merges rather than replacing the existing query", () => {
    // costs writes `days` and `table` from two independent handlers, so a write of
    // one that dropped the other would silently reset the view on every click.
    writeHashParams({ days: "90" });
    writeHashParams({ table: "1" });
    expect(readHashParam("days")).toBe("90");
    expect(readHashParam("table")).toBe("1");
  });

  it("removes a key for null or empty rather than writing an empty value", () => {
    // A cleared search box should leave a clean, shareable URL — `#/truffle?q=` is
    // both ugly and a falsy-but-present value for anything reading it back.
    writeHashParams({ q: "gpu", days: "90" });
    writeHashParams({ q: "" });
    expect(readHashParam("q")).toBeNull();
    writeHashParams({ days: null });
    expect(location.hash).toBe("#/truffle");
  });

  it("replaces the history entry instead of pushing one", async () => {
    // A keystroke-by-keystroke search is not navigation, and filling the back button
    // with it would make Back useless on the one surface where the user most wants it.
    //
    // This is also the observable half of the *other* reason for replaceState: the
    // shell routes on `hashchange`, and replaceState doesn't fire it, so a surface
    // recording its own state can't trip a re-route that disposes it mid-keystroke.
    // That half can't be asserted here — happy-dom fires `hashchange` on
    // replaceState, which browsers do not (the spec's URL-and-history-update steps
    // skip it). Verified in Chromium instead; do not "fix" this by writing through
    // location.hash to make a shim happy.
    location.hash = "#/truffle";
    await new Promise((r) => setTimeout(r, 0));
    const before = history.length;
    writeHashParams({ q: "gpu" });
    writeHashParams({ q: "gpu h100" });
    expect(history.length).toBe(before);
  });

  it("writes a query onto a bare route", () => {
    location.hash = "";
    writeHashParams({ q: "gpu" });
    // "#/" rather than "" — a query hung off an empty hash would read as the
    // document's own query string on the next parse.
    expect(location.hash).toBe("#/?q=gpu");
  });
});
