// Gate: the real-AWS e2e roles. iam/policies/portal-e2e-roles.json is what
// infra/tofu/portal-oidc/main.tf deploys, the e2e role carries the portal
// role's policies and nothing else, and no trust reaches outside the account.
// If the e2e role could do more (or less) than the portal role, every e2e
// proof would be about the wrong role.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { E2E_ROLE_NAME, INSTANCE_TYPE, RUN_TAG, SESSION_PREFIX, TEARDOWN_ROLE_NAME } from "../e2e-aws/config.js";
import type { PolicyDoc, PolicyFile } from "../iam/simulate.js";
import { readTf, tfActions, tfPolicyBlock, tfResource } from "./tf-source.js";

interface TrustStatement {
  Sid?: string;
  Effect: string;
  Principal: Record<string, string | string[]>;
  Action: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}
interface E2ERoles {
  roles: Record<string, { trust: { Version: string; Statement: TrustStatement[] }; inlinePoliciesFrom?: string; policies?: Record<string, PolicyDoc> }>;
}

const here = import.meta.dirname;
const roles = JSON.parse(readFileSync(resolve(here, "../iam/policies/portal-e2e-roles.json"), "utf8")) as E2ERoles;
const portal = JSON.parse(readFileSync(resolve(here, "../iam/policies/portal-launch-role.json"), "utf8")) as PolicyFile;
const tf = readTf();
const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** The for_each map of aws_iam_role_policy.portal_e2e: policy name -> the resource it copies. */
function e2ePolicySources(source: string): Record<string, string> | null {
  const block = tfResource(source, "aws_iam_role_policy", "portal_e2e");
  if (!block) return null;
  const fe = /for_each\s*=\s*\{([^}]*)\}/.exec(block);
  if (!fe) return null;
  const out: Record<string, string> = {};
  for (const m of fe[1].matchAll(/^\s*(\w+)\s*=\s*aws_iam_role_policy\.(\w+)\.policy\s*$/gm)) out[m[1]] = m[2];
  // Anything else in the map (a literal policy, another attribute) is not a copy.
  const lines = fe[1].split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
  return lines.length === Object.keys(out).length ? out : null;
}

/** Whether a principal ARN is in the dev account, as written in the checked-in docs. */
const inAccount = (arn: string) => arn.startsWith("arn:aws:iam::${ACCOUNT_ID}:");

describe("e2e role: the portal role's policies, verbatim", () => {
  const e2e = roles.roles[E2E_ROLE_NAME];

  it("the checked-in doc names the portal policy file and no policy of its own", () => {
    expect(e2e.inlinePoliciesFrom).toBe("portal-launch-role.json");
    expect(e2e.policies).toBeUndefined();
  });

  it("main.tf gives spore-portal-e2e exactly the portal role's inline policies, by reference", () => {
    const src = e2ePolicySources(tf);
    expect(src, "aws_iam_role_policy.portal_e2e must be a for_each of name = aws_iam_role_policy.<x>.policy and nothing else").not.toBeNull();
    expect(Object.keys(src!).sort()).toEqual(Object.keys(portal.policies).sort());
    for (const [name, res] of Object.entries(src!)) {
      const block = tfResource(tf, "aws_iam_role_policy", res);
      expect(block, `aws_iam_role_policy.${res}`).not.toBeNull();
      expect(block!, `aws_iam_role_policy.${res} is not the portal's ${name}`).toContain(`name = "${name}"`);
      expect(block!, `aws_iam_role_policy.${res} is not on the portal role`).toContain("role = aws_iam_role.portal_launch.id");
    }
    expect(tfResource(tf, "aws_iam_role_policy", "portal_e2e")!).toContain("role   = aws_iam_role.portal_e2e.id");
  });

  it("nothing else is attached to the e2e role in main.tf", () => {
    const attached = [...tf.matchAll(/role\s*=\s*aws_iam_role\.portal_e2e\.(?:id|name)/g)].length;
    expect(attached, "only aws_iam_role_policy.portal_e2e may name the e2e role").toBe(1);
    expect(tf).not.toMatch(/aws_iam_role_policy_attachment[\s\S]*?aws_iam_role\.portal_e2e\b/);
  });

  it("fails when the for_each holds a literal policy instead of a copy", () => {
    const changed = tf.replace("PortalSSMSession        = aws_iam_role_policy.ssm_session.policy", 'PortalSSMSession        = jsonencode({ Version = "2012-10-17", Statement = [] })');
    expect(e2ePolicySources(changed)).toBeNull();
  });

  it("trusts this account only: its root, narrowed to named roles in it, with the harness's session name", () => {
    expect(e2e.trust.Statement).toHaveLength(1);
    const s = e2e.trust.Statement[0];
    expect(s.Effect).toBe("Allow");
    expect(s.Principal).toEqual({ AWS: "arn:aws:iam::${ACCOUNT_ID}:root" });
    expect(list(s.Action)).toEqual(["sts:AssumeRole"]);
    const arns = list(s.Condition?.ArnEquals?.["aws:PrincipalArn"]);
    expect(arns.length).toBeGreaterThan(0);
    for (const a of arns) expect(inAccount(a), a).toBe(true);
    expect(arns).toContain(`arn:aws:iam::\${ACCOUNT_ID}:role/${TEARDOWN_ROLE_NAME}`);
    expect(s.Condition?.StringLike?.["sts:RoleSessionName"]).toBe(`${SESSION_PREFIX}*`);
  });

  it("main.tf's trust is the same one", () => {
    const block = tfResource(tf, "aws_iam_role", "portal_e2e")!;
    expect(block).toContain(`name                 = local.e2e_role_name`);
    expect(tf).toContain(`e2e_role_name          = "${E2E_ROLE_NAME}"`);
    expect(tf).toContain(`e2e_teardown_role_name = "${TEARDOWN_ROLE_NAME}"`);
    expect(block).toContain('Sid       = "SameAccountOperatorsAndTeardownRole"');
    expect(block).toContain('Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }');
    expect(block).toContain('Action    = "sts:AssumeRole"');
    expect(block).toContain('ArnEquals  = { "aws:PrincipalArn" = local.e2e_assumers }');
    expect(block).toContain(`StringLike = { "sts:RoleSessionName" = "${SESSION_PREFIX}*" }`);
    expect(block).not.toMatch(/Federated|Service\s*=/);
    // The operator roles: names in this account, defaulting to what the doc lists.
    const operators = list(roles.roles[E2E_ROLE_NAME].trust.Statement[0].Condition?.ArnEquals?.["aws:PrincipalArn"])
      .map((a) => a.replace("arn:aws:iam::${ACCOUNT_ID}:role/", ""))
      .filter((n) => n !== TEARDOWN_ROLE_NAME);
    const def = /variable "e2e_operator_role_names" \{[\s\S]*?default\s*=\s*\[([^\]]*)\]/.exec(tf);
    expect(def).not.toBeNull();
    expect([...def![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(operators);
    expect(tf).toContain('[for n in var.e2e_operator_role_names : "arn:aws:iam::${local.account_id}:role/${n}"]');
  });
});

describe("e2e teardown role", () => {
  const t = roles.roles[TEARDOWN_ROLE_NAME];
  const doc = t.policies!.PortalE2ETeardown;

  it("trusts GitHub OIDC for this repo's main branch only", () => {
    expect(t.trust.Statement).toHaveLength(1);
    const s = t.trust.Statement[0];
    expect(s.Principal).toEqual({ Federated: "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com" });
    expect(s.Condition?.StringEquals).toEqual({
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:spore-host/spore-host:ref:refs/heads/main",
    });
    const block = tfResource(tf, "aws_iam_role", "portal_e2e_teardown")!;
    expect(block).toContain('Sid       = "GitHubActionsMainOnly"');
    expect(block).toContain("Principal = { Federated = aws_iam_openid_connect_provider.github.arn }");
    expect(block).toContain('"${local.github_oidc_host}:sub" = "repo:spore-host/spore-host:ref:refs/heads/main"');
    expect(block).toContain('"${local.github_oidc_host}:aud" = "sts.amazonaws.com"');
  });

  it("main.tf's PortalE2ETeardown has the same actions, Sids and condition keys", () => {
    const block = tfPolicyBlock(tf, "PortalE2ETeardown");
    expect(block).not.toBeNull();
    expect(doc.Statement.flatMap((s) => list(s.Action)).sort()).toEqual(tfActions(block!));
    for (const s of doc.Statement) {
      expect(block!, `Sid ${s.Sid}`).toContain(`"${s.Sid}"`);
      for (const kv of Object.values(s.Condition ?? {})) for (const k of Object.keys(kv)) expect(block!.replace("${local.e2e_run_tag}", RUN_TAG), k).toContain(`"${k}"`);
    }
    expect(tf).toContain(`e2e_run_tag            = "${RUN_TAG}"`);
  });

  it("can terminate only instances that carry the run tag, and close only e2e sessions", () => {
    const term = doc.Statement.find((s) => list(s.Action).includes("ec2:TerminateInstances"))!;
    expect(term.Condition).toEqual({ Null: { [`aws:ResourceTag/${RUN_TAG}`]: "false" }, StringEquals: { "ec2:InstanceType": INSTANCE_TYPE } });
    expect(list(term.Resource)).toEqual(["arn:aws:ec2:us-east-1:${ACCOUNT_ID}:instance/*"]);
    const close = doc.Statement.find((s) => list(s.Action).includes("ssm:TerminateSession"))!;
    expect(list(close.Resource)).toEqual([`arn:aws:ssm:us-east-1:\${ACCOUNT_ID}:session/${SESSION_PREFIX}*`]);
    const assume = doc.Statement.find((s) => list(s.Action).includes("sts:AssumeRole"))!;
    expect(list(assume.Resource)).toEqual([`arn:aws:iam::\${ACCOUNT_ID}:role/${E2E_ROLE_NAME}`]);
    // Every other grant is a read.
    for (const s of doc.Statement.filter((x) => x !== term && x !== close && x !== assume)) for (const a of list(s.Action)) expect(a, a).toMatch(/^(ec2|ssm):Describe/);
    const block = tfPolicyBlock(tf, "PortalE2ETeardown")!;
    expect(block).toContain('Resource = "arn:aws:ec2:us-east-1:${local.account_id}:instance/*"');
    expect(block).toContain('Null         = { "aws:ResourceTag/${local.e2e_run_tag}" = "false" }');
    expect(block).toContain(`StringEquals = { "ec2:InstanceType" = "${INSTANCE_TYPE}" }`);
    expect(block).toContain(`Resource = "arn:aws:ssm:us-east-1:\${local.account_id}:session/${SESSION_PREFIX}*"`);
    expect(block).toContain("Resource = aws_iam_role.portal_e2e.arn");
  });

  it("the audit role can read both e2e roles, for the drift check", () => {
    const block = tfPolicyBlock(tf, "PortalIAMAuditReadOnly")!;
    for (const r of ["portal_launch", "portal_e2e", "portal_e2e_teardown"]) expect(block, r).toContain(`aws_iam_role.${r}.arn`);
  });
});
