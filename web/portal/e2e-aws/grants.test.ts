// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Fixture, PolicyFile } from "../iam/simulate.js";
import { plan, planProblems, REQUIRED_PROOFS, tagGatedGrants, targetFor } from "./grants.js";

const doc = (Statement: PolicyFile["policies"][string]["Statement"]) => ({ Version: "2012-10-17", Statement });
const ssmGate: PolicyFile = {
  role: "r",
  policies: {
    P: doc([
      { Sid: "Run", Effect: "Allow", Action: ["ec2:RunInstances", "ec2:CreateTags"], Resource: "*" },
      { Sid: "Pass", Effect: "Allow", Action: "iam:PassRole", Resource: "*", Condition: { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } } },
      { Sid: "Shell", Effect: "Allow", Action: "ssm:StartSession", Resource: "arn:aws:ec2:*:*:instance/*", Condition: { StringEquals: { "ssm:resourceTag/spawn:managed": "true" } } },
    ]),
  },
};
const inst = "arn:aws:ec2:us-east-1:111122223333:instance/i-0123456789abcdef0";
const fixture = (cases: Fixture["cases"]): Fixture => ({ policyFile: "p.json", account: "111122223333", sporedInstanceRole: "r", cases });
const goodCases: Fixture["cases"] = [
  { name: "shell on managed", action: "ssm:StartSession", resource: inst, context: { "ssm:resourceTag/spawn:managed": "true" }, expect: "allowed", realCall: true },
  { name: "shell elsewhere", action: "ssm:StartSession", resource: inst, expect: "denied" },
  { name: "never terminate managed", action: "ec2:TerminateInstances", resource: inst, context: { "aws:ResourceTag/spawn:managed": "true" }, expect: "denied" },
  { name: "terminate unmanaged", action: "ec2:TerminateInstances", resource: inst, expect: "denied" },
  { name: "terminate managed=false", action: "ec2:TerminateInstances", resource: inst, context: { "aws:ResourceTag/spawn:managed": "false" }, expect: "denied" },
  { name: "pass", action: "iam:PassRole", resource: "arn:aws:iam::111122223333:role/r", context: { "iam:PassedToService": "ec2.amazonaws.com" }, expect: "allowed" },
];

describe("tag-gated grant enumeration", () => {
  it("finds tag conditions and ignores other conditions", () => {
    expect(tagGatedGrants(ssmGate)).toEqual([
      { policy: "P", sid: "Shell", action: "ssm:StartSession", operator: "StringEquals", key: "ssm:resourceTag/spawn:managed", tag: "spawn:managed", values: ["true"] },
    ]);
  });

  it("finds aws:ResourceTag, aws:RequestTag, iam:ResourceTag and aws:TagKeys conditions, one per action", () => {
    const p: PolicyFile = {
      role: "r",
      policies: {
        Q: doc([
          { Effect: "Allow", Action: ["ec2:StopInstances", "ec2:StartInstances"], Resource: "*", Condition: { StringEquals: { "aws:ResourceTag/spawn:managed": "true" } } },
          { Effect: "Allow", Action: "iam:AddRoleToInstanceProfile", Resource: "*", Condition: { StringEquals: { "iam:ResourceTag/spore": "1" } } },
          { Effect: "Allow", Action: "ec2:CreateTags", Resource: "*", Condition: { "ForAllValues:StringEquals": { "aws:TagKeys": ["a"] }, StringEquals: { "aws:RequestTag/a": "b" } } },
          { Effect: "Deny", Action: "ec2:TerminateInstances", Resource: "*", Condition: { StringEquals: { "aws:ResourceTag/x": "y" } } },
        ]),
      },
    };
    expect(tagGatedGrants(p).map((g) => `${g.action} ${g.key}`)).toEqual([
      "ec2:StopInstances aws:ResourceTag/spawn:managed",
      "ec2:StartInstances aws:ResourceTag/spawn:managed",
      "iam:AddRoleToInstanceProfile iam:ResourceTag/spore",
      "ec2:CreateTags aws:TagKeys",
      "ec2:CreateTags aws:RequestTag/a",
    ]);
  });
});

describe("real-call plan", () => {
  it("maps a case's tag context to the instance it describes", () => {
    expect(targetFor(goodCases[0])).toBe("managed");
    expect(targetFor(goodCases[1])).toBe("control");
    expect(targetFor(goodCases[2])).toBe("managed");
    expect(targetFor(goodCases[4])).toBeNull(); // spawn:managed=false: neither instance carries that
    expect(targetFor(goodCases[5])).toBeNull(); // not an instance
  });

  it("plans the executable instance cases only", () => {
    expect(plan(fixture(goodCases)).map((c) => `${c.name}: ${c.action} ${c.target} ${c.expect} (${c.reason})`)).toEqual([
      "shell on managed: ssm:StartSession managed allowed (realCall)",
      "shell elsewhere: ssm:StartSession control denied (untagged control)",
      "never terminate managed: ec2:TerminateInstances managed denied (tag-gated denial)",
      "terminate unmanaged: ec2:TerminateInstances control denied (untagged control)",
    ]);
  });

  it("is complete for a policy whose tag-gated grant is proven both ways", () => {
    expect(planProblems(ssmGate, fixture(goodCases), [])).toEqual([]);
  });

  it("fails a tag-gated grant with no realCall allowed case", () => {
    const cases = goodCases.map((c) => (c.name === "shell on managed" ? { ...c, realCall: false } : c));
    expect(planProblems(ssmGate, fixture(cases), [])).toEqual(["P/Shell grants ssm:StartSession on ssm:resourceTag/spawn:managed, but no fixture case with realCall:true expects it allowed on a spawn:managed=true instance"]);
  });

  it("fails a tag-gated grant with no denied case on the control instance", () => {
    const cases = goodCases.filter((c) => c.name !== "shell elsewhere");
    expect(planProblems(ssmGate, fixture(cases), [])).toEqual(["P/Shell grants ssm:StartSession on ssm:resourceTag/spawn:managed, but no fixture case expects it denied on an instance without spawn:managed"]);
  });

  it("fails a NEW tag-gated grant the harness has no executor for", () => {
    const p = structuredClone(ssmGate);
    p.policies.P.Statement.push({ Sid: "Reboot", Effect: "Allow", Action: "ec2:RebootInstances", Resource: "*", Condition: { StringEquals: { "aws:ResourceTag/spawn:managed": "true" } } });
    const problems = planProblems(p, fixture(goodCases), []);
    expect(problems).toContain("P/Reboot grants ec2:RebootInstances on aws:ResourceTag/spawn:managed, but the e2e harness has no executor for ec2:RebootInstances: add one to e2e-aws/grants.ts EXECUTORS and e2e-aws/aws.ts");
    expect(problems.some((x) => /no fixture case with realCall:true/.test(x))).toBe(true);
  });

  it("fails a tag-gated grant on a tag the run's instance does not carry", () => {
    const p = structuredClone(ssmGate);
    p.policies.P.Statement[2].Condition = { StringEquals: { "ssm:resourceTag/team": "research" } };
    expect(planProblems(p, fixture(goodCases), [])).toContain(
      "P/Shell grants ssm:StartSession on ssm:resourceTag/team=research, but the run's managed instance carries team=(nothing): no real call can satisfy it",
    );
  });

  it("fails a tag condition with an operator the harness cannot plan", () => {
    const p = structuredClone(ssmGate);
    p.policies.P.Statement[2].Condition = { StringLike: { "ssm:resourceTag/spawn:managed": "t*" } };
    expect(planProblems(p, fixture(goodCases), []).some((x) => /with StringLike; the harness plans StringEquals tag conditions only/.test(x))).toBe(true);
  });

  it("fails a denial on a spawn-managed instance the harness cannot make", () => {
    const cases = [...goodCases, { name: "never reboot managed", action: "ec2:RebootInstances", resource: inst, context: { "aws:ResourceTag/spawn:managed": "true" }, expect: "denied" as const }];
    expect(planProblems(ssmGate, fixture(cases), [])).toEqual(['case "never reboot managed" denies ec2:RebootInstances on a spawn-managed instance, but the harness has no executor to prove it']);
  });

  it("fails a realCall case the harness cannot make", () => {
    const cases = [...goodCases, { name: "odd", action: "ec2:RebootInstances", resource: inst, context: { "aws:ResourceTag/spawn:managed": "true" }, expect: "allowed" as const, realCall: true }];
    expect(planProblems(ssmGate, fixture(cases), [])).toContain('case "odd" is realCall:true, but the harness cannot make it (no executor for ec2:RebootInstances, or its context matches neither instance)');
  });
});

describe("the read-only portal's required proofs (#645)", () => {
  const readOnly: PolicyFile = { role: "r", policies: { P: doc([{ Sid: "Read", Effect: "Allow", Action: "ec2:DescribeInstances", Resource: "*" }]) } };
  const cases: Fixture["cases"] = [
    { name: "list", action: "ec2:DescribeInstances", resource: "*", expect: "allowed", realCall: true },
    { name: "launch", action: "ec2:RunInstances", resource: "arn:aws:ec2:us-east-1:111122223333:instance/*", expect: "denied" },
    { name: "tag", action: "ec2:CreateTags", resource: inst, context: { "aws:ResourceTag/spawn:managed": "true" }, expect: "denied" },
    { name: "shell", action: "ssm:StartSession", resource: inst, context: { "ssm:resourceTag/spawn:managed": "true" }, expect: "denied" },
  ];

  it("plans the list and the launch in the account, the tag and the session on the managed instance", () => {
    expect(plan(fixture(cases)).map((c) => `${c.action} ${c.target} ${c.expect}`)).toEqual([
      "ec2:DescribeInstances account allowed",
      "ec2:RunInstances account denied",
      "ec2:CreateTags managed denied",
      "ssm:StartSession managed denied",
    ]);
    expect(planProblems(readOnly, fixture(cases))).toEqual([]);
  });

  it("fails when any of them is not planned", () => {
    for (const r of REQUIRED_PROOFS) {
      const without = cases.filter((c) => c.action !== r.action);
      expect(planProblems(readOnly, fixture(without)).some((p) => p.includes(`${r.expect} ${r.action}`)), r.action).toBe(true);
    }
  });

  it("does not plan an account call whose context it can't reproduce", () => {
    const tagged = { name: "launch tagged", action: "ec2:RunInstances", resource: "*", context: { "aws:RequestTag/x": "y" }, expect: "denied" as const };
    expect(plan(fixture([tagged]))).toEqual([]);
  });
});
