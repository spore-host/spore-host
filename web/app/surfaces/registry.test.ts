// Chat integrations are walled off for 1.0 (spore-host#611): the Slack surface
// is in the registry only when the build opts in with VITE_EXPERIMENTAL_CHAT.
// The deployed portal must not show it, so the default is asserted directly on
// the exported registry, which is what the shell renders.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSurfaces, findSurface, surfaces } from "./registry.js";
import { experimentalChat } from "../features.js";

const ids = (list: { id: string }[]) => list.map((s) => s.id);

describe("chat surfaces are opt-in", () => {
  it("the flag is off unless set to exactly \"true\"", () => {
    expect(experimentalChat({})).toBe(false);
    expect(experimentalChat({ VITE_EXPERIMENTAL_CHAT: "" })).toBe(false);
    expect(experimentalChat({ VITE_EXPERIMENTAL_CHAT: "1" })).toBe(false);
    expect(experimentalChat({ VITE_EXPERIMENTAL_CHAT: "TRUE" })).toBe(false);
    expect(experimentalChat({ VITE_EXPERIMENTAL_CHAT: true })).toBe(false);
    expect(experimentalChat({ VITE_EXPERIMENTAL_CHAT: "true" })).toBe(true);
  });

  it("the default registry has no Slack surface and no route to it", () => {
    expect(ids(surfaces)).not.toContain("slack");
    expect(findSurface("slack")).toBeUndefined();
  });

  it("keeps the spore.host Teams (team sharing) surface either way", () => {
    // "teams" manages spore.host team membership, not Microsoft Teams.
    expect(ids(buildSurfaces(false))).toContain("teams");
    expect(ids(buildSurfaces(true))).toContain("teams");
  });

  it("a default build has no chat surface to add, even when asked", () => {
    // The Slack entry exists only in a build that set the flag, so the default
    // bundle cannot reach it by any path.
    expect(ids(buildSurfaces(true))).toEqual(ids(buildSurfaces(false)));
  });

  describe("a build with VITE_EXPERIMENTAL_CHAT=true", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("gets Slack back in its old place, after Teams", async () => {
      vi.stubEnv("VITE_EXPERIMENTAL_CHAT", "true");
      vi.resetModules();
      const reg = await import("./registry.js");
      const on = ids(reg.surfaces);
      expect(on.indexOf("slack")).toBe(on.indexOf("teams") + 1);
      expect(on.filter((id) => id !== "slack")).toEqual(ids(buildSurfaces(false)));
      expect(reg.findSurface("slack")?.label).toBe("Slack");
    });
  });
});
