// @vitest-environment node
//
// The LIVE half of the IAM coverage gate: SimulateCustomPolicy for real, and
// the drift check of the deployed role against iam/policies/. It calls AWS,
// so it runs only when PORTAL_IAM_LIVE=1, which only
// .github/workflows/portal-iam-live.yml sets, and only after it has assumed a
// role (it skips, with a notice, when no audit role is configured).
//
// Once enabled it never skips quietly: missing or expired credentials fail
// the run, so a lapsed role reads red, not green.
//
// Needs: the AWS CLI; credentials for the account that holds the portal
// role; iam:SimulateCustomPolicy, iam:GetRolePolicy, iam:ListRolePolicies,
// iam:ListAttachedRolePolicies and sts:GetCallerIdentity.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { awsCliSimulator, failures, normalisePolicy, renderPolicies, runFixtures, type Fixture, type PolicyDoc, type PolicyFile } from "./simulate.js";

const live = process.env.PORTAL_IAM_LIVE === "1";
const run = promisify(execFile);
const here = import.meta.dirname;
const policyFile = JSON.parse(readFileSync(resolve(here, "policies/portal-launch-role.json"), "utf8")) as PolicyFile;
const fixture = JSON.parse(readFileSync(resolve(here, "fixtures/portal-launch-role.json"), "utf8")) as Fixture;
const sporedRole = process.env.PORTAL_SPORED_INSTANCE_ROLE ?? fixture.sporedInstanceRole;

async function aws(...args: string[]): Promise<unknown> {
  const { stdout } = await run("aws", [...args, "--output", "json"], { maxBuffer: 1 << 20 });
  return JSON.parse(stdout);
}

async function callerAccount(): Promise<string> {
  const who = (await aws("sts", "get-caller-identity")) as { Account: string };
  return who.Account;
}

describe.skipIf(!live)("IAM coverage gate, live (credential-gated)", () => {
  it("every fixture case gets the expected SimulateCustomPolicy decision", async () => {
    const account = await callerAccount();
    const results = await runFixtures([{ ...fixture, account, sporedInstanceRole: sporedRole }], () => policyFile, awsCliSimulator);
    expect(failures(results)).toEqual([]);
    const needsReal = results.filter((r) => r.case.realCall).map((r) => r.case.name);
    console.log(`tag-gated grants that also need one real call in the e2e harness: ${needsReal.join("; ")}`);
  }, 120_000);

  it("the deployed role's inline policies match iam/policies/ exactly (nightly drift)", async () => {
    const account = await callerAccount();
    const expected = renderPolicies(policyFile, { account, sporedInstanceRole: sporedRole });
    const names = ((await aws("iam", "list-role-policies", "--role-name", policyFile.role)) as { PolicyNames: string[] }).PolicyNames;
    expect([...names].sort()).toEqual(Object.keys(expected).sort());
    const attached = (await aws("iam", "list-attached-role-policies", "--role-name", policyFile.role)) as { AttachedPolicies: unknown[] };
    expect(attached.AttachedPolicies).toEqual([]);
    for (const name of names) {
      const got = (await aws("iam", "get-role-policy", "--role-name", policyFile.role, "--policy-name", name)) as { PolicyDocument: PolicyDoc };
      expect(normalisePolicy(got.PolicyDocument), `policy ${name}`).toEqual(normalisePolicy(expected[name]));
    }
  }, 120_000);
});

describe.runIf(!live)("IAM coverage gate, live", () => {
  it("is skipped: PORTAL_IAM_LIVE is not 1, so no AWS call is made", () => {
    expect(live).toBe(false);
  });
});
