// Gate: every tag-gated grant in iam/policies/ has a real-call proof in the
// real-AWS e2e harness, in both directions, every denial #678 requires on a
// spawn-managed instance is made for real, and so is the read-only posture
// (#645: listed, denied launch, tag and session; e2e-aws/grants.ts REQUIRED_PROOFS). Enumerated from the policy file,
// so a new tag-gated grant fails this gate on its PR until the harness can
// prove it (e2e-aws/grants.ts). Offline: it reads files, it calls nothing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { plan, planProblems, tagGatedGrants } from "../e2e-aws/grants.js";
import type { Fixture, PolicyFile } from "../iam/simulate.js";

const here = import.meta.dirname;
const policy = JSON.parse(readFileSync(resolve(here, "../iam/policies/portal-launch-role.json"), "utf8")) as PolicyFile;
const fixture = JSON.parse(readFileSync(resolve(here, "../iam/fixtures/portal-launch-role.json"), "utf8")) as Fixture;

describe("real-AWS e2e plan covers every tag-gated grant", () => {
  it("has no unproven tag-gated grant", () => {
    expect(planProblems(policy, fixture)).toEqual([]);
  });

  it("today: no tag-gated grant at all, the portal role is read-only (#645)", () => {
    expect(tagGatedGrants(policy)).toEqual([]);
  });

  it("proves the read-only posture for real: listed, and denied launch, tag, session and lifecycle on a spawn-managed instance (#701, #678)", () => {
    const calls = plan(fixture).map((c) => `${c.action} ${c.target} ${c.expect}`);
    expect(calls).toEqual(
      expect.arrayContaining([
        "ec2:DescribeInstances account allowed",
        "ec2:RunInstances account denied",
        "ec2:CreateTags managed denied",
        "ssm:StartSession managed denied",
        "ssm:StartSession control denied",
        "ec2:StopInstances managed denied",
        "ec2:StartInstances managed denied",
        "ec2:TerminateInstances managed denied",
      ]),
    );
    expect(calls.filter((c) => c.endsWith(" allowed"))).toEqual(["ec2:DescribeInstances account allowed"]);
  });
});
