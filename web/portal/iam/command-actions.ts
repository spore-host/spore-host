// IAM coverage gate, step 2: the CLOSED table from AWS SDK command to the IAM
// actions it needs.
//
// Every command the build plugin finds in the bundle must be a key here, or
// the gate fails. A command is added to this table on purpose, in review,
// with the actions it needs and a statement in iam/policies/ that grants
// them; it is never inferred. Keys are "<@aws-sdk/client-* suffix>:<Operation>".
//
// Deliberately ABSENT:
// - ec2:DescribeInstanceTypeOfferings. It answers "is this type offered in
//   this zone", not "is one free". Using it as a capacity signal is #679
//   ("availability without use is worthless"). If it reaches the bundle, the
//   gate fails and someone has to argue for it here.

export interface CommandMapping {
  /** IAM actions the call needs. Empty only with a reason. */
  actions: string[];
  /** Why the actions are what they are. Required when `actions` is empty. */
  why?: string;
}

export const COMMAND_ACTIONS: Readonly<Record<string, CommandMapping>> = {
  // ── Sign-in (spawn-ts/auth, lib/session.ts) ─────────────────────────────
  "sts:AssumeRoleWithWebIdentity": {
    actions: [],
    why: "Authorised by the role's trust policy (Globus aud + sub), not by an identity policy: the caller has no AWS credentials yet.",
  },
  "sts:GetCallerIdentity": {
    actions: [],
    why: "Needs no permission. AWS allows it for every principal and no policy can deny it.",
  },

  // ── Instances: list, status, launch (slices 2-3, #685/#686) ─────────────
  "ec2:DescribeInstances": { actions: ["ec2:DescribeInstances"] },
  "ec2:DescribeInstanceStatus": { actions: ["ec2:DescribeInstanceStatus"] },
  "ec2:DescribeImages": { actions: ["ec2:DescribeImages"] },
  "ec2:DescribeSubnets": { actions: ["ec2:DescribeSubnets"] },
  "ec2:DescribeSecurityGroups": { actions: ["ec2:DescribeSecurityGroups"] },
  "ec2:DescribeVpcs": { actions: ["ec2:DescribeVpcs"] },
  "ec2:DescribeKeyPairs": { actions: ["ec2:DescribeKeyPairs"] },
  "ec2:RunInstances": {
    actions: ["ec2:RunInstances", "ec2:CreateTags", "iam:PassRole"],
    why: "Tags at launch need ec2:CreateTags on the new resources; attaching spored's instance profile needs iam:PassRole on its role.",
  },
  "ec2:CreateTags": { actions: ["ec2:CreateTags"] },
  // Stop, Start and Terminate are mapped but NOT granted: the live role lost
  // them on 2026-11-10 (#678). If one reaches the bundle, the inventory gains
  // the action, the fixture rule "every inventory action has an allowed case"
  // fails, and the tagged-denial fixtures fail too, until slice 3 (#686) ships
  // them with #678's scoped policy.
  "ec2:StopInstances": { actions: ["ec2:StopInstances"] },
  "ec2:StartInstances": { actions: ["ec2:StartInstances"] },
  "ec2:TerminateInstances": { actions: ["ec2:TerminateInstances"] },

  // ── Prices and quotas (slices 2 and 5, #685/#688) ───────────────────────
  "ec2:DescribeSpotPriceHistory": { actions: ["ec2:DescribeSpotPriceHistory"] },
  "service-quotas:GetServiceQuota": { actions: ["servicequotas:GetServiceQuota"] },
  "service-quotas:ListServiceQuotas": { actions: ["servicequotas:ListServiceQuotas"] },

  // ── Connect (slice 4, #687) ─────────────────────────────────────────────
  "ssm:StartSession": { actions: ["ssm:StartSession"] },
  "ssm:TerminateSession": { actions: ["ssm:TerminateSession"] },
  "ssm:ResumeSession": { actions: ["ssm:ResumeSession"] },
};
