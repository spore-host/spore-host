// @vitest-environment node
//
// Gate: the IAM simulation fixtures (offline half). The fixtures meet the
// required-negative-case rules, and they agree with the checked-in policy
// under the offline evaluator. The live SimulateCustomPolicy run is
// iam/live.test.ts, credential-gated. NO AWS call is made here.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Inventory } from "../iam/inventory.js";
import { failures, fixtureProblems, offlineSimulator, runFixtures, type Fixture, type PolicyFile } from "../iam/simulate.js";

const iam = resolve(import.meta.dirname, "../iam");
const policy = JSON.parse(readFileSync(resolve(iam, "policies/portal-launch-role.json"), "utf8")) as PolicyFile;
const fixture = JSON.parse(readFileSync(resolve(iam, "fixtures/portal-launch-role.json"), "utf8")) as Fixture;
const inventory = JSON.parse(readFileSync(resolve(iam, "inventory.json"), "utf8")) as Inventory;

describe("IAM coverage gate: simulation fixtures", () => {
  it("meet the required-negative-case rules for the policy and the inventory", () => {
    expect(fixtureProblems([fixture], [policy], inventory.actions)).toEqual([]);
  });

  it("agree with the checked-in policy (offline evaluator)", async () => {
    expect(failures(await runFixtures([fixture], () => policy, offlineSimulator()))).toEqual([]);
  });

  it("fail when a conditioned grant has no denied case", () => {
    const broken = { ...fixture, cases: fixture.cases.filter((c) => !(c.action === "ec2:TerminateInstances" && c.expect === "denied")) };
    expect(fixtureProblems([broken], [policy], [])).toContain("PortalEC2Launch/Lifecycle grants ec2:TerminateInstances under a condition, but no case tests it denied");
  });

  it("fail when an inventory action has no allowed case", () => {
    expect(fixtureProblems([fixture], [policy], ["ec2:DescribeVpcs"])).toContain("inventory action ec2:DescribeVpcs has no case expected to be allowed");
  });

  it("fail when a fixture has no denied case at all", () => {
    const broken = { ...fixture, cases: fixture.cases.filter((c) => c.expect === "allowed") };
    expect(fixtureProblems([broken], [policy], [])[0]).toMatch(/has no case expected to be denied/);
  });

  it("fail when the policy loses its tag gate", async () => {
    // The #678 failure mode: an unconditioned grant defeats the spawn:managed gate.
    const ungated = JSON.parse(JSON.stringify(policy)) as PolicyFile;
    delete ungated.policies.PortalEC2Launch.Statement[1].Condition;
    const f = failures(await runFixtures([fixture], () => ungated, offlineSimulator()));
    expect(f).toContain('"terminate an instance spawn did not launch": ec2:TerminateInstances on arn:aws:ec2:us-east-1:111122223333:instance/i-0123456789abcdef0 was allowed, expected denied');
  });
});
