// Gate: every tag-gated grant in iam/policies/ has a real-call proof in the
// real-AWS e2e harness, in both directions, and every denial #678 requires on
// a spawn-managed instance is made for real. Enumerated from the policy file,
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

  it("today: ssm:StartSession on spawn:managed is the one tag-gated grant", () => {
    expect(tagGatedGrants(policy).map((g) => `${g.action} ${g.key}=${g.values.join("|")}`)).toEqual(["ssm:StartSession ssm:resourceTag/spawn:managed=true"]);
  });

  it("proves StartSession both ways, and Stop, Start and Terminate denied on a spawn-managed instance (#678)", () => {
    const calls = plan(fixture).map((c) => `${c.action} ${c.target} ${c.expect}`);
    expect(calls).toEqual(
      expect.arrayContaining([
        "ssm:StartSession managed allowed",
        "ssm:StartSession control denied",
        "ec2:StopInstances managed denied",
        "ec2:StartInstances managed denied",
        "ec2:TerminateInstances managed denied",
      ]),
    );
  });
});
