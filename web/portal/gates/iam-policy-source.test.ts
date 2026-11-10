// Gate: iam/policies/portal-launch-role.json is the policy that
// infra/tofu/portal-oidc/main.tf deploys. Compares the actions, Sids and
// condition keys of each inline policy, by name, from the HCL source. The
// deployed role is compared by the credential-gated live job.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PolicyFile } from "../iam/simulate.js";

const policy = JSON.parse(readFileSync(resolve(import.meta.dirname, "../iam/policies/portal-launch-role.json"), "utf8")) as PolicyFile;
const tf = readFileSync(resolve(import.meta.dirname, "../../../infra/tofu/portal-oidc/main.tf"), "utf8");

/** The text of the aws_iam_role_policy block whose name is `name`. */
function tfPolicyBlock(source: string, name: string): string | null {
  const at = source.indexOf(`name = "${name}"`);
  if (at === -1) return null;
  const end = source.indexOf('\nresource "', at);
  return source.slice(at, end === -1 ? undefined : end);
}

/** IAM actions named in Action = ... lines of an HCL policy block. Comments stripped. */
function tfActions(block: string): string[] {
  const clean = block.replace(/#.*$/gm, "");
  const out: string[] = [];
  for (const m of clean.matchAll(/Action\s*=\s*(\[[^\]]*\]|"[^"]*")/g)) {
    for (const a of m[1].matchAll(/"([a-z0-9-]+:[A-Za-z0-9*]+)"/g)) out.push(a[1]);
  }
  return out.sort();
}

function jsonActions(name: string): string[] {
  return policy.policies[name].Statement.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])).sort();
}

describe("IAM policy fixture matches the tofu source", () => {
  for (const name of Object.keys(policy.policies)) {
    it(`${name}: same actions as infra/tofu/portal-oidc/main.tf`, () => {
      const block = tfPolicyBlock(tf, name);
      expect(block, `no aws_iam_role_policy named ${name} in main.tf`).not.toBeNull();
      expect(jsonActions(name)).toEqual(tfActions(block!));
    });

    it(`${name}: same Sids and condition keys`, () => {
      const block = tfPolicyBlock(tf, name)!;
      for (const s of policy.policies[name].Statement) {
        if (s.Sid) expect(block, `${name}: Sid ${s.Sid}`).toContain(`"${s.Sid}"`);
        for (const kv of Object.values(s.Condition ?? {})) for (const k of Object.keys(kv)) expect(block, `${name}: condition key ${k}`).toContain(`"${k}"`);
      }
    });
  }

  it("names the role main.tf creates", () => {
    expect(tf).toContain(`role_name     = "${policy.role}"`);
  });

  it("fails when main.tf grants an action the fixture does not have", () => {
    const changed = tf.replace('"ec2:DescribeKeyPairs",', '"ec2:DescribeKeyPairs",\n          "ec2:ModifyInstanceAttribute",');
    expect(jsonActions("PortalEC2Launch")).not.toEqual(tfActions(tfPolicyBlock(changed, "PortalEC2Launch")!));
  });
});
