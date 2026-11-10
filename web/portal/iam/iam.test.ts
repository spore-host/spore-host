// Unit tests for the IAM harness logic on synthetic inputs, so every failure
// mode is shown failing. The gates on the real files are in gates/iam-*.test.ts.
import { describe, expect, it } from "vitest";
import { COMMAND_ACTIONS } from "./command-actions.js";
import { buildInventory, inventoryDrift } from "./inventory.js";
import { failures, fixtureProblems, glob, normalisePolicy, offlineSimulator, renderPolicies, runFixtures, type Fixture, type PolicyFile } from "./simulate.js";

describe("closed command table", () => {
  it("maps known commands to actions", () => {
    const r = buildInventory(["ec2:RunInstances", "sts:GetCallerIdentity"], COMMAND_ACTIONS);
    expect(r.problems).toEqual([]);
    expect(r.inventory.actions).toEqual(["ec2:CreateTags", "ec2:RunInstances", "iam:PassRole"]);
  });

  it("fails an unmapped command", () => {
    const r = buildInventory(["ec2:DescribeInstanceTypeOfferings"], COMMAND_ACTIONS);
    expect(r.unmapped).toEqual(["ec2:DescribeInstanceTypeOfferings"]);
    expect(r.problems[0]).toMatch(/not in portal\/iam\/command-actions\.ts/);
  });

  it("fails an empty mapping with no reason, and a malformed action", () => {
    const r = buildInventory(["x:A", "x:B"], { "x:A": { actions: [] }, "x:B": { actions: ["not an action"] } });
    expect(r.problems).toEqual(["x:A maps to no IAM action and gives no reason", 'x:B: "not an action" is not an IAM action']);
  });

  it("every table entry with no actions gives a reason", () => {
    for (const [k, v] of Object.entries(COMMAND_ACTIONS)) if (v.actions.length === 0) expect(v.why, k).toBeTruthy();
  });

  it("keeps the offering lookup out of the table (#679)", () => {
    expect(COMMAND_ACTIONS["ec2:DescribeInstanceTypeOfferings"]).toBeUndefined();
  });
});

describe("inventory drift", () => {
  const a = buildInventory(["sts:GetCallerIdentity"], COMMAND_ACTIONS).inventory;
  const b = buildInventory(["sts:GetCallerIdentity", "ec2:TerminateInstances"], COMMAND_ACTIONS).inventory;

  it("is empty when current", () => {
    expect(inventoryDrift(a, a)).toEqual([]);
  });

  it("fails when the bundle gains a command the inventory lacks", () => {
    expect(inventoryDrift(a, b)).toEqual([
      "bundle has ec2:TerminateInstances -> [ec2:TerminateInstances], inventory does not",
      "inventory actions [] differ from bundle actions [ec2:TerminateInstances]",
    ]);
  });

  it("fails when the inventory lists a command the bundle lost", () => {
    expect(inventoryDrift(b, a)[0]).toBe("inventory has ec2:TerminateInstances -> [ec2:TerminateInstances], bundle does not");
  });
});

const policy: PolicyFile = {
  role: "r",
  policies: {
    P: {
      Version: "2012-10-17",
      Statement: [
        { Sid: "Read", Effect: "Allow", Action: ["ec2:DescribeInstances"], Resource: "*" },
        { Sid: "Gated", Effect: "Allow", Action: ["ec2:TerminateInstances"], Resource: "*", Condition: { StringEquals: { "aws:ResourceTag/spawn:managed": "true" } } },
        { Sid: "Pass", Effect: "Allow", Action: "iam:PassRole", Resource: "arn:aws:iam::${ACCOUNT_ID}:role/${SPORED_INSTANCE_ROLE}" },
        { Sid: "NoS3", Effect: "Deny", Action: "s3:*", Resource: "*" },
      ],
    },
  },
};
const fixture: Fixture = {
  policyFile: "p.json",
  account: "111122223333",
  sporedInstanceRole: "spored-instance-role",
  cases: [
    { name: "read", action: "ec2:DescribeInstances", resource: "*", expect: "allowed" },
    { name: "term ok", action: "ec2:TerminateInstances", resource: "arn:i", context: { "aws:ResourceTag/spawn:managed": "true" }, expect: "allowed" },
    { name: "term no tag", action: "ec2:TerminateInstances", resource: "arn:i", expect: "denied" },
    { name: "pass", action: "iam:PassRole", resource: "arn:aws:iam::${ACCOUNT_ID}:role/${SPORED_INSTANCE_ROLE}", expect: "allowed" },
    { name: "s3", action: "s3:GetObject", resource: "arn:aws:s3:::b/k", expect: "denied" },
  ],
};

describe("simulation fixtures", () => {
  it("accepts complete fixtures", () => {
    expect(fixtureProblems([fixture], [policy], ["ec2:DescribeInstances", "ec2:TerminateInstances"])).toEqual([]);
  });

  it("requires a denied case per fixture, per conditioned action, and an allowed case per inventory action", () => {
    const noNeg = { ...fixture, cases: fixture.cases.filter((c) => c.expect === "allowed") };
    expect(fixtureProblems([noNeg], [policy], ["ec2:RunInstances"])).toEqual([
      "fixture for p.json has no case expected to be denied",
      "inventory action ec2:RunInstances has no case expected to be allowed",
      "P/Gated grants ec2:TerminateInstances under a condition, but no case tests it denied",
    ]);
  });

  it("rejects an allowed case for an action no statement grants", () => {
    const f = { ...fixture, cases: [...fixture.cases, { name: "x", action: "ec2:RebootInstances", resource: "*", expect: "allowed" as const }] };
    expect(fixtureProblems([f], [policy], [])).toEqual(['case "x" expects ec2:RebootInstances allowed, but no statement grants it']);
  });

  it("runs cases through an injected simulator with the fixture's account substituted", async () => {
    const seen: string[] = [];
    const r = await runFixtures([fixture], () => policy, async (req) => {
      seen.push(req.resource);
      return "allowed";
    });
    expect(seen).toContain("arn:aws:iam::111122223333:role/spored-instance-role");
    expect(failures(r)).toEqual([
      '"term no tag": ec2:TerminateInstances on arn:i was allowed, expected denied',
      '"s3": s3:GetObject on arn:aws:s3:::b/k was allowed, expected denied',
    ]);
  });

  it("offline evaluator: conditions, wildcards, explicit deny", async () => {
    expect(failures(await runFixtures([fixture], () => policy, offlineSimulator()))).toEqual([]);
    const sim = offlineSimulator();
    const docs = Object.values(renderPolicies(policy, fixture)).map((d) => JSON.stringify(d));
    expect(await sim({ policies: docs, action: "s3:GetObject", resource: "x", context: {} })).toBe("explicitDeny");
    expect(await sim({ policies: docs, action: "ec2:TerminateInstances", resource: "x", context: { "aws:resourcetag/spawn:managed": "true" } })).toBe("allowed");
    const unsupported = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "a:B", Resource: "*", Condition: { StringLike: { k: "v" } } }] });
    await expect(sim({ policies: [unsupported], action: "a:B", resource: "*", context: {} })).rejects.toThrow(/does not evaluate StringLike/);
  });

  it("matches IAM wildcards without regexes", () => {
    expect(glob("*", "anything", false)).toBe(true);
    expect(glob("arn:aws:ec2:*:*:instance/*", "arn:aws:ec2:us-east-1:111122223333:instance/i-1", false)).toBe(true);
    expect(glob("arn:aws:ec2:*:*:instance/*", "arn:aws:ec2:us-east-1:111122223333:volume/v-1", false)).toBe(false);
    expect(glob("s3:*", "S3:GetObject", true)).toBe(true);
    expect(glob("ec2:Describe*", "ec2:RunInstances", true)).toBe(false);
    expect(glob("a*b*c", "abc", false)).toBe(true);
    expect(glob("a*b*c", "acb", false)).toBe(false);
    expect(glob("a.b", "axb", false)).toBe(false);
  });

  it("normalises policy documents for the drift comparison", () => {
    const a = normalisePolicy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["b:B", "a:A"], Resource: "*" }] });
    const b = normalisePolicy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["a:A", "b:B"], Resource: ["*"] }] });
    expect(a).toEqual(b);
    const c1 = normalisePolicy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "a:A", Resource: "*", Condition: { StringEquals: { k: "v" } } }] });
    const c2 = normalisePolicy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "a:A", Resource: "*", Condition: { StringEquals: { k: ["v"] } } }] });
    expect(c1).toEqual(c2);
    // A changed Sid, value or operator is still drift.
    const c3 = normalisePolicy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "a:A", Resource: "*", Condition: { StringLike: { k: "v" } } }] });
    expect(c1).not.toEqual(c3);
  });
});
