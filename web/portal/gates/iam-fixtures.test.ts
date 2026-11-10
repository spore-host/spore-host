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
    const broken = { ...fixture, cases: fixture.cases.filter((c) => !(c.action === "ssm:StartSession" && c.expect === "denied")) };
    expect(fixtureProblems([broken], [policy], [])).toContain(
      "PortalSSMSession/StartSessionOnManagedInstances grants ssm:StartSession under a condition, but no case tests it denied",
    );
  });

  it("fail when an inventory action has no allowed case", () => {
    expect(fixtureProblems([fixture], [policy], ["ec2:DescribeVpcs"])).toContain("inventory action ec2:DescribeVpcs has no case expected to be allowed");
  });

  it("fail when a fixture has no denied case at all", () => {
    const broken = { ...fixture, cases: fixture.cases.filter((c) => c.expect === "allowed") };
    expect(fixtureProblems([broken], [policy], [])[0]).toMatch(/has no case expected to be denied/);
  });

  it("deny Stop, Start and Terminate even on a spawn-managed instance (#678, until slice 3 #686)", () => {
    for (const action of ["ec2:StopInstances", "ec2:StartInstances", "ec2:TerminateInstances"]) {
      const tagged = fixture.cases.filter((c) => c.action === action && c.context?.["aws:ResourceTag/spawn:managed"] === "true");
      expect(tagged.map((c) => c.expect), action).toEqual(["denied"]);
    }
  });

  it("fail when a lifecycle grant comes back, even tag-gated", async () => {
    // The pre-2026-11-10 Lifecycle statement, restored.
    const restored = JSON.parse(JSON.stringify(policy)) as PolicyFile;
    restored.policies.PortalEC2Launch.Statement.push({
      Sid: "Lifecycle",
      Effect: "Allow",
      Action: ["ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances"],
      Resource: "*",
      Condition: { StringEquals: { "aws:ResourceTag/spawn:managed": "true" } },
    });
    const f = failures(await runFixtures([fixture], () => restored, offlineSimulator()));
    expect(f).toHaveLength(3);
    expect(f[0]).toMatch(/^"never terminate from the browser, even a spawn-managed instance \(#678\)": ec2:TerminateInstances on arn:aws:ec2:us-east-1:111122223333:instance\/i-0123456789abcdef0 was allowed, expected denied$/);
  });

  it("fail when the command-line grant loses its tag gate", async () => {
    const ungated = JSON.parse(JSON.stringify(policy)) as PolicyFile;
    delete ungated.policies.PortalSSMSession.Statement[0].Condition;
    const f = failures(await runFixtures([fixture], () => ungated, offlineSimulator()));
    expect(f).toEqual([expect.stringMatching(/^"open a command line on any other instance": ssm:StartSession .* was allowed, expected denied$/)]);
  });
});
