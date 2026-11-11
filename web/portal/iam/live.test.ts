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
// role; iam:SimulateCustomPolicy, and iam:GetRole, iam:GetRolePolicy,
// iam:ListRolePolicies and iam:ListAttachedRolePolicies on the portal role
// and the two e2e roles (spore-portal-e2e, spore-portal-e2e-teardown);
// sts:GetCallerIdentity needs no grant.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { awsCliSimulator, failures, normalisePolicy, normaliseTrust, renderPolicies, runFixtures, type Fixture, type PolicyDoc, type PolicyFile, type TrustDoc } from "./simulate.js";

const live = process.env.PORTAL_IAM_LIVE === "1";
const run = promisify(execFile);
const here = import.meta.dirname;
const policyFile = JSON.parse(readFileSync(resolve(here, "policies/portal-launch-role.json"), "utf8")) as PolicyFile;
const fixture = JSON.parse(readFileSync(resolve(here, "fixtures/portal-launch-role.json"), "utf8")) as Fixture;
const sporedRole = process.env.PORTAL_SPORED_INSTANCE_ROLE ?? fixture.sporedInstanceRole;
// The real-AWS e2e roles (e2e-aws/, #683). The e2e role must carry exactly the
// portal role's policies, or the e2e harness proves another role's grants.
const e2eRoles = JSON.parse(readFileSync(resolve(here, "policies/portal-e2e-roles.json"), "utf8")) as {
  roles: Record<string, { trust: TrustDoc; inlinePoliciesFrom?: string; policies?: Record<string, PolicyDoc> }>;
};

async function aws(...args: string[]): Promise<unknown> {
  const { stdout } = await run("aws", [...args, "--output", "json"], { maxBuffer: 1 << 20 });
  return JSON.parse(stdout);
}

/** Inline policies and attachments of a deployed role must be exactly `expected`, by name. */
async function expectRolePolicies(role: string, expected: Record<string, PolicyDoc>): Promise<void> {
  const names = ((await aws("iam", "list-role-policies", "--role-name", role)) as { PolicyNames: string[] }).PolicyNames;
  expect([...names].sort(), `${role}: inline policy names`).toEqual(Object.keys(expected).sort());
  const attached = (await aws("iam", "list-attached-role-policies", "--role-name", role)) as { AttachedPolicies: unknown[] };
  expect(attached.AttachedPolicies, `${role}: attached managed policies`).toEqual([]);
  for (const name of names) {
    const got = (await aws("iam", "get-role-policy", "--role-name", role, "--policy-name", name)) as { PolicyDocument: PolicyDoc };
    expect(normalisePolicy(got.PolicyDocument), `${role}: policy ${name}`).toEqual(normalisePolicy(expected[name]));
  }
}

const renderAccount = <T>(doc: T, account: string): T => JSON.parse(JSON.stringify(doc).replaceAll("${ACCOUNT_ID}", account)) as T;

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
    await expectRolePolicies(policyFile.role, expected);
  }, 120_000);

  it("the e2e role's inline policies equal the portal role's, and its trust stays in the account (nightly drift)", async () => {
    const account = await callerAccount();
    const portal = renderPolicies(policyFile, { account, sporedInstanceRole: sporedRole });
    for (const [role, spec] of Object.entries(e2eRoles.roles)) {
      const expected = spec.inlinePoliciesFrom === "portal-launch-role.json" ? portal : renderAccount(spec.policies ?? {}, account);
      await expectRolePolicies(role, expected);
      const got = (await aws("iam", "get-role", "--role-name", role)) as { Role: { AssumeRolePolicyDocument: TrustDoc; PermissionsBoundary?: unknown } };
      expect(normaliseTrust(got.Role.AssumeRolePolicyDocument), `${role}: trust policy`).toEqual(normaliseTrust(renderAccount(spec.trust, account)));
      // A boundary on either role would make their effective permissions differ
      // while their policies match: a denial could then be the boundary's.
      expect(got.Role.PermissionsBoundary, `${role}: permissions boundary`).toBeUndefined();
    }
    const portalRole = (await aws("iam", "get-role", "--role-name", policyFile.role)) as { Role: { PermissionsBoundary?: unknown } };
    expect(portalRole.Role.PermissionsBoundary, `${policyFile.role}: permissions boundary`).toBeUndefined();
  }, 120_000);
});

describe.runIf(!live)("IAM coverage gate, live", () => {
  it("is skipped: PORTAL_IAM_LIVE is not 1, so no AWS call is made", () => {
    expect(live).toBe(false);
  });
});
