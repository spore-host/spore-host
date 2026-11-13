// #704: a production portal build must not let a link choose the Globus app or
// the AWS role. resolveConfig honours client_id/role_arn only when
// VITE_PORTAL_CONFIG_OVERRIDES=1 (or in the dev server), so only the gate
// build's env file may set it. A .env, .env.production or .env.local that set
// it would quietly turn the overrides back on for the shipped build.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portal = resolve(__dirname, "..");

describe("config overrides gate (#704)", () => {
  it("only portal/.env.gate sets VITE_PORTAL_CONFIG_OVERRIDES", () => {
    const setters = readdirSync(portal)
      .filter((f) => f.startsWith(".env"))
      .filter((f) => /^\s*VITE_PORTAL_CONFIG_OVERRIDES\s*=/m.test(readFileSync(resolve(portal, f), "utf8")));
    expect(setters).toEqual([".env.gate"]);
  });

  it("main.ts passes the build-time switch, not a literal true", () => {
    const main = readFileSync(resolve(portal, "src", "main.ts"), "utf8");
    expect(main).toMatch(/allowIdentityOverrides:\s*identityOverridesAllowed\(/);
    expect(main).not.toMatch(/allowIdentityOverrides:\s*true/);
  });
});
