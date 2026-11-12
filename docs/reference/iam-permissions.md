---
description: "spore.host tools act on EC2 with your AWS credentials (see AWS Authentication for how those are obtained)."
---

# IAM Permissions

spore.host tools act on EC2 with **your** AWS credentials (see [AWS Authentication](../guides/aws-auth.md) for how those are obtained). This page is the least-privilege IAM policy those credentials need. Attach it to the IAM role/user you authenticate as, and expand only as your usage grows (Spot, DNS, FSx below).

## Recommended least-privilege baseline

This is the recommended least-privilege policy for the core flow — **`spawn launch`
→ connect → manage → terminate**. Each action is traced to the spawn code that
calls it. Optional features (FSx, the `spawn dns` commands) add their own
permissions, listed further down.

The policy is built so that holding it gives no path to IAM administration
and no reach into instances spawn didn't launch:

- **Roles spawn creates are capped by a permissions boundary.** Every IAM write
  to an instance role (`iam:CreateRole`, `iam:PutRolePolicy`,
  `iam:AttachRolePolicy`) is allowed only when the role has the boundary
  `arn:aws:iam::<account>:policy/spore-host/spawn-instance-boundary`. Whatever
  is written onto the role, its effective permissions are the intersection with
  that boundary, and this policy can't change, remove or replace the boundary.
- **Tags that decide ownership are written only at creation.** `ec2:CreateTags`
  is allowed on any resource only as part of the request that creates it
  (`ec2:CreateAction`). Afterwards, spawn may change only its own `spawn:*`
  keys on instances and Spot requests already tagged `spawn:managed=true`
  (volumes are the one exception, below), and an explicit
  `Deny` stops anyone holding this policy from writing or deleting the keys
  that say which resources spawn owns. That is what keeps the tag-scoped
  statements below (`EC2Manage`, `SendCommand`) scoped.

::: warning Requires spawn to provision the boundary
spawn sets `spore-host/spawn-instance-boundary` on the roles it creates, and
creates the boundary once per account
([below](#the-permissions-boundary)), so you don't write it. **Released spawn
versions don't do this yet.** Until a spawn release that does, `CreateRole` and every policy
write on an instance role are refused under this policy, so a launch that has
to create or update a role fails. The earlier version of this page granted
those actions without the boundary condition. That version let anyone holding
it give an instance role any permissions, so it is not a safe stand-in. This
policy also hasn't yet been checked by a real `spawn launch` (the earlier one
was, on 2026-10-18 with spawn v0.134.0).
:::

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
        "ec2:AuthorizeSecurityGroupIngress"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TagOnCreate",
      "Effect": "Allow",
      "Action": "ec2:CreateTags",
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "ec2:CreateAction": [
            "RunInstances",
            "CreateSecurityGroup",
            "ImportKeyPair"
          ]
        }
      }
    },
    {
      "Sid": "RetagSpawnInstances",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateTags",
        "ec2:DeleteTags"
      ],
      "Resource": [
        "arn:aws:ec2:*:*:instance/*",
        "arn:aws:ec2:*:*:spot-instances-request/*"
      ],
      "Condition": {
        "StringEquals": {
          "ec2:ResourceTag/spawn:managed": "true"
        },
        "ForAllValues:StringLike": {
          "aws:TagKeys": [
            "spawn:*",
            "spore:plugin:*"
          ]
        }
      }
    },
    {
      "Sid": "TagSpawnVolumesFromSnapshots",
      "Effect": "Allow",
      "Action": "ec2:CreateTags",
      "Resource": "arn:aws:ec2:*:*:volume/*",
      "Condition": {
        "StringEquals": {
          "ec2:ResourceTag/spawn:managed": "true"
        }
      }
    },
    {
      "Sid": "DenyOwnershipTagsAfterCreate",
      "Effect": "Deny",
      "Action": [
        "ec2:CreateTags",
        "ec2:DeleteTags"
      ],
      "Resource": "*",
      "Condition": {
        "Null": {
          "ec2:CreateAction": "true"
        },
        "ForAnyValue:StringEquals": {
          "aws:TagKeys": [
            "spawn:managed",
            "spawn:root",
            "spawn:created-by",
            "spawn:iam-user",
            "spawn:account-id",
            "spawn:launch-time",
            "spawn:config",
            "spawn:nested-parent",
            "spawn:pre-stop",
            "spawn:pre-stop-timeout",
            "spawn:local-username",
            "spawn:instance-id",
            "spawn:instance-arn"
          ]
        }
      }
    },
    {
      "Sid": "InstanceProfileForSpored",
      "Effect": "Allow",
      "Action": [
        "iam:GetRole",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
        "iam:GetRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetInstanceProfile",
        "iam:CreateInstanceProfile",
        "iam:AddRoleToInstanceProfile",
        "iam:TagRole",
        "iam:TagInstanceProfile",
        "iam:ListInstanceProfiles"
      ],
      "Resource": [
        "arn:aws:iam::*:role/spored*",
        "arn:aws:iam::*:instance-profile/spored*",
        "arn:aws:iam::*:role/spawn-instance-*",
        "arn:aws:iam::*:instance-profile/spawn-instance-*"
      ]
    },
    {
      "Sid": "CreateBoundedInstanceRoles",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:PutRolePolicy",
        "iam:PutRolePermissionsBoundary"
      ],
      "Resource": [
        "arn:aws:iam::*:role/spored*",
        "arn:aws:iam::*:role/spawn-instance-*"
      ],
      "Condition": {
        "ArnLike": {
          "iam:PermissionsBoundary": "arn:aws:iam::*:policy/spore-host/spawn-instance-boundary"
        }
      }
    },
    {
      "Sid": "AttachSporedPoliciesToBoundedRoles",
      "Effect": "Allow",
      "Action": "iam:AttachRolePolicy",
      "Resource": [
        "arn:aws:iam::*:role/spored*",
        "arn:aws:iam::*:role/spawn-instance-*"
      ],
      "Condition": {
        "ArnLike": {
          "iam:PermissionsBoundary": "arn:aws:iam::*:policy/spore-host/spawn-instance-boundary",
          "iam:PolicyARN": [
            "arn:aws:iam::*:policy/spore-host/spored-*",
            "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
          ]
        }
      }
    },
    {
      "Sid": "SporedManagedPolicyRead",
      "Effect": "Allow",
      "Action": [
        "iam:GetPolicy",
        "iam:GetPolicyVersion"
      ],
      "Resource": "arn:aws:iam::*:policy/spore-host/*"
    },
    {
      "Sid": "SporedManagedPolicy",
      "Effect": "Allow",
      "Action": [
        "iam:CreatePolicy",
        "iam:DeletePolicy"
      ],
      "Resource": "arn:aws:iam::*:policy/spore-host/spored-*"
    },
    {
      "Sid": "DetachSporedManagedPolicy",
      "Effect": "Allow",
      "Action": "iam:DetachRolePolicy",
      "Resource": [
        "arn:aws:iam::*:role/spored*",
        "arn:aws:iam::*:role/spawn-instance-*"
      ],
      "Condition": {
        "ArnLike": {
          "iam:PolicyARN": "arn:aws:iam::*:policy/spore-host/spored-*"
        }
      }
    },
    {
      "Sid": "DenyBoundaryChanges",
      "Effect": "Deny",
      "Action": [
        "iam:CreatePolicy",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
        "iam:TagPolicy",
        "iam:UntagPolicy"
      ],
      "Resource": "arn:aws:iam::*:policy/spore-host/spawn-instance-boundary"
    },
    {
      "Sid": "DenyBoundaryRemoval",
      "Effect": "Deny",
      "Action": "iam:DeleteRolePermissionsBoundary",
      "Resource": "*"
    },
    {
      "Sid": "PassSporedRoleToEC2",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::*:role/spored*",
        "arn:aws:iam::*:role/spawn-instance-*"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "ec2.amazonaws.com"
        }
      }
    },
    {
      "Sid": "EC2Manage",
      "Effect": "Allow",
      "Action": [
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:TerminateInstances"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "ec2:ResourceTag/spawn:managed": "true"
        }
      }
    },
    {
      "Sid": "PriceLookup",
      "Effect": "Allow",
      "Action": "pricing:GetProducts",
      "Resource": "*"
    },
    {
      "Sid": "VerifySporedOverSSM",
      "Effect": "Allow",
      "Action": [
        "ssm:DescribeInstanceInformation",
        "ssm:GetCommandInvocation"
      ],
      "Resource": "*"
    },
    {
      "Sid": "RunSporedStatusOnSpawnInstances",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": "arn:aws:ec2:*:*:instance/*",
      "Condition": {
        "StringEquals": {
          "ssm:resourceTag/spawn:managed": "true"
        }
      }
    },
    {
      "Sid": "RunScriptDocuments",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ssm:*::document/AWS-RunShellScript",
        "arn:aws:ssm:*::document/AWS-RunPowerShellScript"
      ]
    },
    {
      "Sid": "Identity",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

::: warning Why the extra statements are required
A launch does more than `RunInstances`. spawn **imports your SSH public key** (`ec2:ImportKeyPair`), may **create a security group** for the instance (`ec2:CreateSecurityGroup` / `AuthorizeSecurityGroupIngress`), and — so the in-instance `spored` daemon can manage the instance's lifecycle — **creates a `spored` IAM role + instance profile and passes it to EC2 at launch** (the `iam:*` on `spored*` + `iam:PassRole`). Roles and profiles are created with tags, which IAM authorises separately (`iam:TagRole`, `iam:TagInstanceProfile`). spored's own grants go on that role as a customer-managed policy, `arn:aws:iam::<account>:policy/spore-host/spored-policy-v<N>` (or `spored-baseline-policy-v<N>`, `spored-nested-baseline-policy-v<N>`), because a role's inline policies share one 10,240-character limit with whatever else is on the role (since spawn v0.163.1, [spawn#1573](https://github.com/spore-host/spawn/issues/1573)). That is what `SporedManagedPolicy`, `SporedManagedPolicyRead` and `DetachSporedManagedPolicy` are for: spawn creates the policy once per account, attaches it, and detaches and deletes an older version when a newer spawn replaces it. Without them spawn warns and writes the grants inline instead, which fails on a role whose inline policies are near the limit. `iam:ListRolePolicies`, `iam:GetRolePolicy` and `iam:DeleteRolePolicy` let spawn remove the inline copies older versions wrote, and list their sizes if the inline limit is ever hit. A launch that grants the instance extra access (`--iam-policy`, `--s3-read`, `--s3-write`, and every `spawn task run`) creates a role named `spawn-instance-<hash>` instead, which is why that pattern is included. Omit these and `spawn launch` fails partway.

**What the IAM statements allow, and what they don't.** The name patterns limit
which roles you can touch; they don't limit what goes on those roles. IAM can't
condition `PutRolePolicy` or `CreatePolicy` on the document's contents, and
spawn writes caller-chosen documents by design (`--iam-policy-file`, the task
staging policy). So the containment is the boundary, not the names:

- `CreateRole`, `PutRolePolicy` and `AttachRolePolicy` are allowed only on a
  role whose permissions boundary is `spore-host/spawn-instance-boundary`.
  `PutRolePermissionsBoundary` can only set that boundary, which is how spawn
  moves a role created before the boundary existed onto it. Nothing in the
  policy removes a boundary or edits the boundary policy (`DenyBoundaryChanges`,
  `DenyBoundaryRemoval`).
- `AttachRolePolicy` is limited to spawn's own `spore-host/spored-*` policies
  and `AmazonSSMManagedInstanceCore`. To use `--iam-managed-policies`, add the
  [statement below](#managed-policies-on-instance-roles).
- `CreatePolicy` and `DeletePolicy` cover only `spore-host/spored-*`, the names
  spawn writes. A policy you create there is still capped by the boundary when
  attached.
- `iam:UpdateAssumeRolePolicy`, `iam:DeleteRolePermissionsBoundary` and
  `iam:CreatePolicyVersion` are not granted.

What this doesn't contain: within the boundary, you can still give an instance
access you don't hold yourself, for example S3 on a bucket your own identity
can't read, through `--iam-policy-file`. The boundary removes IAM
administration and account-level changes from what an instance role can hold;
it doesn't make an instance role a subset of your own permissions, which IAM
can't express. If that matters in your account, an administrator should
narrow the resource scopes in the boundary, or launch with `--instance-profile`
naming a profile they manage.

After launching, spawn **verifies spored is running** by waiting for the
`spawn:last-heartbeat` tag spored writes about once a minute, read with
`ec2:DescribeInstances` (since spawn v0.136.0). That action is load-bearing: if
it's refused, the launch stops at once with "spored could not be verified" and
names the action. It doesn't claim the instance is broken.

The SSM statements (`ssm:DescribeInstanceInformation`, then `ssm:SendCommand`
of `spored status` and `ssm:GetCommandInvocation`) are a second signal, which
can answer before the first heartbeat on an AMI with the SSM agent. They're
**optional for launch**: without them the launch still verifies by the
heartbeat, and a refused SSM call is reported by its action name instead of
being retried. Keep them anyway if you can, because other commands use them:
`spawn connect`'s SSM fallback, `spawn extend` reloading spored on an instance
with no SSH key, and `spawn terminate` flushing a task's logs first.
`SendCommand` is limited to spawn-managed instances. (Before v0.136.0, launch
verification used only SSM, and a caller without these actions was told spored
never came up.)
`pricing:GetProducts` sets the instance's price tag. Without it, a launch with
`--cost-limit` is refused, because a limit that can't be priced can't be
enforced. `iam:ListInstanceProfiles` is used by `spawn doctor`. `spawn cleanup --instance-roles` also deletes spored managed policies no role has attached; that needs `iam:ListPolicies` (on `"*"`, as IAM offers no narrower resource for it) and the `iam:DeletePolicy` above.

The **default AMI** is found through AWS's public SSM parameters, so `ssm:GetParameter` on `/aws/service/...` is needed unless you always pass `--ami`. The `/spawn/dns/*` parameters are where an administrator can set a [custom DNS](../guides/self-hosting.md#step-3-point-launches-at-your-updater) domain for a whole account. If spawn can't read them, it uses spore.host's DNS instead, without warning ([spawn#1121](https://github.com/spore-host/spawn/issues/1121)).
:::

::: tip Scope on tags
`EC2Manage` and `RunSporedStatusOnSpawnInstances` are conditioned on
`spawn:managed=true`, so you can only start, stop, terminate or run commands on
instances spawn created. That holds only because nothing in this policy can put
`spawn:managed` on an existing resource: `TagOnCreate` applies to the request
that creates a resource, `RetagSpawnInstances` reaches only resources already
tagged and only `spawn:*` and `spore:plugin:*` keys, and
`DenyOwnershipTagsAfterCreate` refuses writes and deletes of the ownership keys
on any existing resource. After launch, spawn writes only keys outside that
list: the TTL and cost-limit keys (`spawn extend`), `spawn:dns-*`
(`spawn dns`), `spawn:fsx-*`, `spawn:last-st*` (`spawn stop`/`start`),
`spawn:spored-version`, `spawn:spot-price-per-hour`,
`spawn:original-instance-id` on a persistent Spot request, and
`spore:plugin:<name>`. `TagSpawnVolumesFromSnapshots` copies an attached
snapshot's own tags onto its volume, which can carry any key, so it isn't
limited to `spawn:*`; it is still limited to spawn-managed volumes and still
under the ownership `Deny`. `ec2:ModifyInstanceAttribute` and
`ec2:DescribeTags`, in earlier versions of this page, are gone: the CLI calls
neither.

The read (`Describe*`) and launch statements can't be tag-scoped (the resources
don't exist yet at describe/launch time).
:::

### The permissions boundary

`arn:aws:iam::<account>:policy/spore-host/spawn-instance-boundary` is a
customer-managed policy, one per account, that spawn sets as the permissions
boundary of every role it creates (`spored-instance-role`, every
`spawn-instance-*` role, and `spawn-pool-worker-*`). It allows the services
spawn's instance grants use (spored's self-management, the `--iam-policy`
shorthands, task staging, FSx, DNS registration) and refuses IAM writes other
than passing spawn's own roles to EC2. You don't write or edit it.

Creating it needs `iam:CreatePolicy` on its name, which the policy above
refuses on purpose: a caller who could create the boundary could choose its
contents. So it's created once per account by spawn running under
administrator credentials, at the point an administrator sets spawn up for the
account. The spawn release that provisions it will name the command; until
then, see the warning at the top of this section.

### Managed policies on instance roles

`--iam-managed-policies` attaches the managed policies you name to the
instance's role. To allow it, add this statement. It is still conditioned on
the boundary, so whatever you attach is capped by it:

```json
{
  "Sid": "AttachManagedPoliciesToBoundedRoles",
  "Effect": "Allow",
  "Action": "iam:AttachRolePolicy",
  "Resource": "arn:aws:iam::*:role/spawn-instance-*",
  "Condition": {
    "ArnLike": {
      "iam:PermissionsBoundary": "arn:aws:iam::*:policy/spore-host/spawn-instance-boundary"
    }
  }
}
```

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
[Custom DNS](/guides/custom-dns) covers using your own domain and the
permissions each side needs.

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

## Worker pools

`spawn pool` creates an SQS queue and a per-pool worker role,
`spawn-pool-worker-<hash>`, which the baseline's IAM statements don't cover
(they're scoped to `spored*` and `spawn-instance-*`). This list comes from the
code, not from a tested minimal policy:

- **`create`**: the baseline's launch actions for the workers;
  `sqs:CreateQueue`, `sqs:GetQueueUrl` and `sqs:DeleteQueue` (to clean up a
  pool that didn't come up); `s3:ListBucket` on the results bucket
  `spawn-results-<account>-<region>`, plus `s3:CreateBucket` the first time;
  and the baseline's `InstanceProfileForSpored`, `CreateBoundedInstanceRoles`,
  `AttachSporedPoliciesToBoundedRoles` and `PassSporedRoleToEC2` statements
  with `spawn-pool-worker-*` roles and instance profiles added to their
  resources. Keep the boundary conditions: they are what cap the worker role.
- **`submit`**: `s3:PutObject` on the results bucket, `sqs:GetQueueUrl` and
  `sqs:SendMessage`.
- **`status`**: `sqs:GetQueueUrl` and `sqs:GetQueueAttributes`.
- **`drain`**: `sqs:GetQueueUrl` and `sqs:DeleteQueue`; `ec2:DescribeInstances`
  to check that no worker still uses the role; and, to delete the pool's role
  and instance profile, these on `spawn-pool-worker-*`:

```json
{
  "Action": [
    "iam:GetInstanceProfile",
    "iam:RemoveRoleFromInstanceProfile",
    "iam:DeleteInstanceProfile",
    "iam:ListRolePolicies",
    "iam:DeleteRolePolicy",
    "iam:ListAttachedRolePolicies",
    "iam:DetachRolePolicy",
    "iam:ListInstanceProfilesForRole",
    "iam:DeleteRole"
  ],
  "Resource": [
    "arn:aws:iam::*:role/spawn-pool-worker-*",
    "arn:aws:iam::*:instance-profile/spawn-pool-worker-*"
  ]
}
```

If drain can't delete the role, it says so and the queue is still gone.

## The TTL reaper

Deploying, arming and removing an in-account reaper with `spawn reaper` needs
Lambda, EventBridge, S3, CloudWatch Logs and IAM permissions on the reaper's
own resources. Since spawn v0.136.0 that includes `logs:CreateLogGroup`,
`logs:TagResource` and `logs:PutRetentionPolicy` for `deploy`, and
`logs:DeleteLogGroup` for `teardown`. The full list per subcommand is in
[the reaper guide](/guides/reaper#permissions).

## Logs after termination

`spawn logs` on a terminated instance reads the instance's console output (see
[Logs and debugging](/guides/logs)). That needs one more action, which the baseline
doesn't include:

```json
{
  "Action": "ec2:GetConsoleOutput",
  "Resource": "*"
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

Add the [Spot](#spot-instances), [DNS](#dns-integration), [worker pool](#worker-pools), [FSx](#fsx-for-lustre), or [service-quota](#service-quotas) statements only if you use those features.

The instance itself runs under spawn's `spored` role, which spawn creates with
the permissions spored needs, capped by the
[permissions boundary](#the-permissions-boundary). This page covers only your
own policy.

::: tip Prefer least privilege over `PowerUserAccess`
It's tempting to attach `PowerUserAccess` while getting started, but start with the policy above. `PowerUserAccess` grants `ec2:CreateTags` on every resource with no condition, so a caller holding it can put `spawn:managed=true` on any instance, and every grant here that is scoped by that tag stops being scoped. If you must broaden temporarily, tighten back to this policy before any shared or production use.
:::
