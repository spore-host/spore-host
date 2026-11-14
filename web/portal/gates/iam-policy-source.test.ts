// Gate: iam/policies/portal-launch-role.json is the policy that
// infra/tofu/portal-oidc/main.tf deploys. Compares the actions, Sids and
// condition keys of each inline policy, by name, from the HCL source. The
// deployed role is compared by the credential-gated live job.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PolicyFile } from "../iam/simulate.js";
import { readTf, tfActions, tfPolicyBlock } from "./tf-source.js";

const policy = JSON.parse(readFileSync(resolve(import.meta.dirname, "../iam/policies/portal-launch-role.json"), "utf8")) as PolicyFile;
const tf = readTf();

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

  it("is read-only: only Describe and quota reads, no condition anywhere (#645)", () => {
    for (const doc of Object.values(policy.policies))
      for (const st of doc.Statement) {
        expect(st.Effect).toBe("Allow");
        expect(st.Condition).toBeUndefined();
        for (const a of Array.isArray(st.Action) ? st.Action : [st.Action]) expect(a, a).toMatch(/^(ec2:Describe[A-Za-z]+|servicequotas:(Get|List)[A-Za-z]+)$/);
      }
  });

  it("names the role main.tf creates", () => {
    expect(tf).toContain(`role_name     = "${policy.role}"`);
  });

  it("fails when main.tf grants an action the fixture does not have", () => {
    const changed = tf.replace('"ec2:DescribeTags",', '"ec2:DescribeTags",\n          "ec2:ModifyInstanceAttribute",');
    expect(changed).not.toBe(tf);
    expect(jsonActions("PortalReadOnly")).not.toEqual(tfActions(tfPolicyBlock(changed, "PortalReadOnly")!));
  });
});
