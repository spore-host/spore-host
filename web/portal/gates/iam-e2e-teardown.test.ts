// Gate: the e2e teardown role's policy against its SimulateCustomPolicy
// fixtures (iam/fixtures/portal-e2e-teardown.json), offline. The live job runs
// the same cases through the real simulator (iam/live.test.ts).
//
// The case that matters most: terminate is denied on a tagged instance that is
// not a t4g.nano. ec2:CreateTags on * (#678) lets a portal or e2e session forge
// the run tag on any instance; the instance-type condition is what keeps a
// forged tag from reaching anything but the type the harness launches.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTANCE_TYPE } from "../e2e-aws/config.js";
import { teardownPolicyFile } from "../iam/e2e-roles.js";
import { failures, fixtureProblems, offlineSimulator, runFixtures, type Fixture, type PolicyFile } from "../iam/simulate.js";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../iam/fixtures/portal-e2e-teardown.json"), "utf8")) as Fixture;
const policy = teardownPolicyFile();

describe("e2e teardown role: fixtures", () => {
  it("are complete: a denied case for every action of every conditioned statement", () => {
    expect(fixtureProblems([fixture], [policy], [])).toEqual([]);
  });

  it("agree with the checked-in policy (offline evaluator)", async () => {
    expect(failures(await runFixtures([fixture], () => policy, offlineSimulator()))).toEqual([]);
  });

  it("pin terminate to tagged instances of the harness's one instance type", () => {
    const term = policy.policies.PortalE2ETeardown.Statement.find((s) => s.Sid === "TerminateE2EInstancesOnly")!;
    expect(term.Condition?.StringEquals).toEqual({ "ec2:InstanceType": INSTANCE_TYPE });
    const forged = fixture.cases.find((c) => c.action === "ec2:TerminateInstances" && c.context?.["ec2:InstanceType"] !== INSTANCE_TYPE && c.context?.["aws:ResourceTag/spore-host:e2e-run"]);
    expect(forged?.expect, "a case must deny terminate on a tagged instance of another type").toBe("denied");
  });

  it("fails when the instance-type condition is dropped: the forged-tag case comes back allowed", async () => {
    const loose = structuredClone(policy) as PolicyFile;
    const term = loose.policies.PortalE2ETeardown.Statement.find((s) => s.Sid === "TerminateE2EInstancesOnly")!;
    delete term.Condition!.StringEquals;
    expect(failures(await runFixtures([fixture], () => loose, offlineSimulator()))).toEqual([
      '"terminate a tagged instance that is not a t4g.nano (a forged tag on someone else\'s instance)": ec2:TerminateInstances on arn:aws:ec2:us-east-1:111122223333:instance/i-0123456789abcdef0 was allowed, expected denied',
    ]);
  });

  it("fails when the tag condition is dropped: an untagged t4g.nano comes back allowed", async () => {
    const loose = structuredClone(policy) as PolicyFile;
    delete loose.policies.PortalE2ETeardown.Statement.find((s) => s.Sid === "TerminateE2EInstancesOnly")!.Condition!.Null;
    expect(failures(await runFixtures([fixture], () => loose, offlineSimulator()))).toEqual([
      '"terminate an untagged t4g.nano": ec2:TerminateInstances on arn:aws:ec2:us-east-1:111122223333:instance/i-0123456789abcdef0 was allowed, expected denied',
    ]);
  });
});
