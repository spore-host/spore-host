// @vitest-environment node
//
// Gate: the IAM coverage inventory (offline half). Builds the PRODUCTION
// bundle with the real portal config, lists the AWS SDK commands that survive
// in it, maps them through the closed table and compares with the checked-in
// inventory. Fails on an unmapped command and on a stale inventory.
//
// Set PORTAL_IAM_UPDATE=1 (npm run portal:iam:update) to rewrite the inventory.
//
// The same build proves two deploy-safety facts: the production bundle
// contains no test hooks, and it is written under .portal-build/, not dist/.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";
import { COMMAND_ACTIONS } from "../iam/command-actions.js";
import { buildInventory, inventoryDrift, serialiseInventory, type Inventory } from "../iam/inventory.js";

const portal = resolve(import.meta.dirname, "..");
const web = resolve(portal, "..");
const outDir = resolve(web, ".portal-build/production");
const report = resolve(web, ".portal-build/reports/sdk-commands.production.json");
const inventoryPath = resolve(portal, "iam/inventory.json");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("IAM coverage gate: bundle inventory", () => {
  let commands: string[] = [];

  beforeAll(async () => {
    await build({ configFile: resolve(portal, "vite.config.ts"), mode: "production", logLevel: "warn" });
    commands = (JSON.parse(readFileSync(report, "utf8")) as { commands: { command: string }[] }).commands.map((c) => c.command);
  }, 120_000);

  it("the production build goes to .portal-build/, never dist/", () => {
    expect(existsSync(resolve(outDir, "index.html"))).toBe(true);
    expect(existsSync(resolve(web, "dist/portal"))).toBe(false);
  });

  it("finds the SDK commands the shell really contains", () => {
    // A gate that finds nothing must not pass: the session's account lookup is in the bundle.
    expect(commands).toContain("sts:GetCallerIdentity");
  });

  it("every SDK command in the bundle is in the closed table", () => {
    expect(buildInventory(commands, COMMAND_ACTIONS).problems).toEqual([]);
  });

  it("the checked-in inventory matches the bundle", () => {
    const current = buildInventory(commands, COMMAND_ACTIONS).inventory;
    if (process.env.PORTAL_IAM_UPDATE === "1") writeFileSync(inventoryPath, serialiseInventory(current));
    const checkedIn = JSON.parse(readFileSync(inventoryPath, "utf8")) as Inventory;
    expect(inventoryDrift(checkedIn, current), "run `npm run portal:iam:update` and commit iam/inventory.json").toEqual([]);
  });

  it("the production bundle has no test hooks, gallery or self-test page", () => {
    const all = files(outDir);
    expect(all.filter((f) => /gallery|selftest/.test(f))).toEqual([]);
    for (const f of all.filter((x) => x.endsWith(".js") || x.endsWith(".html"))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toContain("spore-portal-test-hooks");
      expect(text, f).not.toContain("TESTHOOK");
    }
  });
});
