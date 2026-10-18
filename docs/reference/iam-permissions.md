---
description: "spore.host tools act on EC2 with your AWS credentials (see AWS Authentication for how those are obtained)."
---

# IAM Permissions

spore.host tools act on EC2 with **your** AWS credentials (see [AWS Authentication](../guides/aws-auth.md) for how those are obtained). This page is the least-privilege IAM policy those credentials need. Attach it to the IAM role/user you authenticate as, and expand only as your usage grows (Spot, DNS, FSx below).

## Recommended least-privilege baseline

This is the recommended least-privilege policy for the core flow — **`spawn launch`
→ connect → manage → terminate**. Each action is traced to the spawn code that
calls it (rechecked against spawn v0.134.0); dropping a core action will fail at
launch (see the callout below). Optional features (FSx, the `spawn dns` commands)
add their own permissions, listed further down.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EC2ReadAndLaunch",
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeImages",
        "ec2:DescribeSubnets",
        "ec2:DescribeVpcs",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeKeyPairs",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeRegions",
        "ec2:DescribeSpotPriceHistory"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ParameterLookups",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": [
        "arn:aws:ssm:*::parameter/aws/service/ami-amazon-linux-latest/*",
        "arn:aws:ssm:*::parameter/aws/service/deeplearning/*",
        "arn:aws:ssm:*:*:parameter/spawn/dns/*"
      ]
    },
    {
      "Sid": "EC2ProvisionSupport",
      "Effect": "Allow",
      "Action": [
        "ec2:ImportKeyPair",
        "ec2:CreateSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:CreateTags"
      ],
      "Resource": "*"
    },
    {
      "Sid": "InstanceProfileForSpored",
      "Effect": "Allow",
      "Action": [
        "iam:GetRole",
        "iam:CreateRole",
        "iam:PutRolePolicy",
        "iam:AttachRolePolicy",
        "iam:GetInstanceProfile",
        "iam:CreateInstanceProfile",
        "iam:AddRoleToInstanceProfile",
        "iam:TagRole",
        "iam:TagInstanceProfile"
      ],
      "Resource": [
        "arn:aws:iam::*:role/spored*",
        "arn:aws:iam::*:instance-profile/spored*",
        "arn:aws:iam::*:role/spawn-instance-*",
        "arn:aws:iam::*:instance-profile/spawn-instance-*"
      ]
    },
    {
      "Sid": "PassSporedRoleToEC2",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::*:role/spored*",
        "arn:aws:iam::*:role/spawn-instance-*"
      ],
      "Condition": { "StringEquals": { "iam:PassedToService": "ec2.amazonaws.com" } }
    },
    {
      "Sid": "EC2Manage",
      "Effect": "Allow",
      "Action": [
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:TerminateInstances",
        "ec2:DeleteTags",
        "ec2:DescribeTags",
        "ec2:ModifyInstanceAttribute"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "ec2:ResourceTag/spawn:managed": "true"
        }
      }
    },
    {
      "Sid": "Identity",
      "Effect": "Allow",
      "Action": ["sts:GetCallerIdentity"],
      "Resource": "*"
    }
  ]
}
```

::: warning Why the extra statements are required
A launch does more than `RunInstances`. spawn **imports your SSH public key** (`ec2:ImportKeyPair`), may **create a security group** for the instance (`ec2:CreateSecurityGroup` / `AuthorizeSecurityGroupIngress`), and — so the in-instance `spored` daemon can manage the instance's lifecycle — **creates a `spored` IAM role + instance profile and passes it to EC2 at launch** (the `iam:*` on `spored*` + `iam:PassRole`). Roles and profiles are created with tags, which IAM authorises separately (`iam:TagRole`, `iam:TagInstanceProfile`). A launch that grants the instance extra access (`--iam-policy`, `--s3-read`, `--s3-write`, and every `spawn task run`) creates a role named `spawn-instance-<hash>` instead, which is why that pattern is included. Omit these and `spawn launch` fails partway. The `iam:*` grants are scoped to these two name patterns so they can't touch other roles.

The **default AMI** is found through AWS's public SSM parameters, so `ssm:GetParameter` on `/aws/service/...` is needed unless you always pass `--ami`. The `/spawn/dns/*` parameters are where an administrator can set a [custom DNS](../guides/self-hosting.md#step-3-point-launches-at-your-updater) domain for a whole account. If spawn can't read them, it uses spore.host's DNS instead, without warning ([spawn#1121](https://github.com/spore-host/spawn/issues/1121)).
:::

::: tip Scope on tags
`EC2Manage` is conditioned on `spawn:managed=true`, so you can only start/stop/terminate instances spawn created — never unrelated ones. The read (`Describe*`) and launch statements can't be tag-scoped (the resources don't exist yet at describe/launch time).
:::

::: tip Note on `sts:GetCallerIdentity`
The `Identity` statement is included for completeness because spawn calls
`sts:GetCallerIdentity` to confirm which account/identity you're operating as. AWS
returns identity from this call even without an explicit `Allow` (and even under an
explicit `Deny`), so you can omit this statement with no functional change — it's
listed so the policy mirrors every call spawn makes.
:::

## Spot instances

`--spot` needs no extra actions: spawn requests Spot capacity through
`RunInstances`, and tags the request with `CreateTags`, both already granted
above. Cancelling a persistent Spot request is done on the instance by spored,
under its own role.

The **first** Spot launch in an AWS account also has EC2 create its Spot
service-linked role. If that role (`AWSServiceRoleForEC2Spot`) doesn't exist yet
and you can't create it, the launch fails. An administrator can create it once,
or you can allow:

```json
{
  "Effect": "Allow",
  "Action": "iam:CreateServiceLinkedRole",
  "Resource": "*",
  "Condition": { "StringEquals": { "iam:AWSServiceName": "spot.amazonaws.com" } }
}
```

## DNS integration

Instance DNS names need **no** permissions in your policy. spored registers the
record from the instance, through a DNS updater (spore.host's, or
[your own](../guides/self-hosting.md)), and the CLI never calls Route 53.

The exception is the `spawn dns register` and `spawn dns delete` commands, which
call the updater with your credentials. When the updater is in another account
(spore.host's always is), your policy must allow that call too:

```json
{
  "Effect": "Allow",
  "Action": "lambda:InvokeFunctionUrl",
  "Resource": "*",
  "Condition": { "StringEquals": { "lambda:FunctionUrlAuthType": "AWS_IAM" } }
}
```

## FSx for Lustre

For a shared filesystem (`spawn launch --fsx-create …` or `--fsx-id …`, and the
`spawn fsx` commands), spawn calls:

```json
{
  "Action": [
    "fsx:CreateFileSystem",
    "fsx:DeleteFileSystem",
    "fsx:DescribeFileSystems",
    "fsx:CreateDataRepositoryAssociation"
  ],
  "Resource": "*"
}
```

Creating a filesystem also needs what FSx itself requires on first use in an
account, including its service-linked role. See AWS's
[FSx for Lustre permissions](https://docs.aws.amazon.com/fsx/latest/LustreGuide/setting-up.html).

## Service quotas

truffle checks instance quotas before suggesting instance types. Add:

```json
{
  "Action": [
    "servicequotas:GetServiceQuota",
    "servicequotas:ListServiceQuotas"
  ],
  "Resource": "*"
}
```

## Applying the policy

Save the minimal policy to `spore-host-policy.json`, then attach it to the role or user you authenticate as ([aws login](../guides/aws-auth.md) or a profile):

```sh
aws iam put-role-policy \
  --role-name your-spore-host-role \
  --policy-name spore-host \
  --policy-document file://spore-host-policy.json
```

Add the [Spot](#spot-instances), [DNS](#dns-integration), [FSx](#fsx-for-lustre), or [service-quota](#service-quotas) statements only if you use those features.

The instance itself runs under spawn's `spored` role, which spawn creates with
the permissions spored needs. This page covers only your own policy.

::: tip Prefer least privilege over `PowerUserAccess`
It's tempting to attach `PowerUserAccess` while getting started, but the policy above is small and complete — start with it. If you must broaden temporarily, tighten back to this policy before any shared or production use.
:::
