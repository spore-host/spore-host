---
description: "spawn doctor checks you're ready to launch, spawn footprint lists everything spawn has created in an account, and spawn onboard connects an account to the spore.host portal."
---

# Checking your account: `spawn doctor`, `spawn footprint` and `spawn onboard`

Three commands look at the AWS account itself rather than at one instance:

| Command | What it does | Changes anything? |
|---|---|---|
| [`spawn doctor`](#spawn-doctor-ready-to-launch) | Checks that you can launch | **No.** Read-only |
| [`spawn footprint`](#spawn-footprint-what-spawn-has-left-in-the-account) | Lists everything spawn has created in the account | **No.** Read-only, never deletes |
| [`spawn onboard`](#spawn-onboard-connect-an-account-to-the-portal) | Connects the account to the spore.host portal | **Yes.** Creates an IAM role and registers it with the portal |

## `spawn doctor`: ready to launch?

Run it before your first launch, after changing profile or account, and
whenever a launch fails in a way that looks like permissions.

```sh
spawn doctor
spawn doctor --region us-west-2
spawn doctor -o json
```

It launches nothing and changes nothing. The launch check uses EC2's `DryRun`,
which tests permission without starting an instance.

### What it checks

Each check is ✓ pass, ⚠ warning, ✗ fail, or – skipped. A **warning** means an
optional feature isn't available; you can still launch. A **failure** means a
launch won't work.

| Check | How | If it's missing |
|---|---|---|
| `spawn version` | The running binary | Always passes |
| `truffle installed` | `truffle` on your `PATH` | ⚠ (truffle is for finding capacity) |
| `AWS CLI available` | `aws` on your `PATH` | ⚠ (needed for `aws login`) |
| `SSH key` | `~/.ssh/id_ed25519`, `id_rsa` or `id_ecdsa`, or a spawn-managed key | ⚠ (spawn generates a key for you) |
| `AWS credentials` | `sts:GetCallerIdentity` | ✗, and every AWS check after it is skipped |
| `account` | The account your credentials resolve to | ✗ if it isn't the one in `SPORE_ACCOUNT` or `--account` |
| `region` | The resolved region | ✗ if there isn't one |
| `EC2 describe permission` | `ec2:DescribeInstances` | ✗ |
| `EC2 launch permission` | `ec2:RunInstances` with `DryRun` | ✗ |
| `IAM instance-profile permission` | `iam:ListInstanceProfiles` | ✗ |
| `spored role` | Whether the `spored-instance-profile` instance profile exists | ⚠ (spawn creates it on the first launch, if you're allowed to) |
| `VPC & subnet` | A default VPC with at least one subnet | ✗ (create a default VPC, or pass `--subnet-id` when you launch) |
| `Session Manager` | `ssm:DescribeInstanceInformation` | ⚠ (`spawn connect` can't fall back to SSM) |
| `TTL reaper backstop` | Whether a [reaper](#the-reaper-check) covers this account | ⚠ |
| `Route 53 (DNS)` | `route53:ListHostedZones` | ⚠ (see [below](#the-route-53-check)) |
| `Nitro fleet` | `ec2:DescribeInstanceTypes`: the region's Nitro instance families, by generation | ⚠ if the newest is older than Nitro v4 |

The VPC check looks only for a **default** VPC. If the account has none and you
always launch with `--subnet-id`, that failure doesn't apply to you, but it still
makes `spawn doctor` exit `1`.

A failed or warning check prints a line starting `→` that says what to fix and
gives AWS's error. On an institution-managed account, send the failing checks
to your administrator with the [IAM baseline](/reference/iam-permissions) or
the [deployment packet](/reference/deployment-packet).

#### The reaper check

spored enforces the TTL from inside the instance. The TTL reaper is the backstop
outside it: it catches instances spored can't act on, such as a stopped one or
one whose spored has died. The check passes if this account has a reaper Lambda,
or the `spawn-ttl-reaper-ec2` role that lets a reaper in another account reach
it. If neither exists, the warning says to deploy one with `spawn reaper deploy`.
If spawn can't tell (for example, you lack `lambda:ListFunctions` or
`iam:GetRole`), it says it couldn't determine coverage, and why.

#### The Route 53 check

This check only lists the hosted zones your credentials can see. spawn's DNS
names don't use Route 53 in your account: spored registers them through a DNS
updater (spore.host's, or [your own](/guides/custom-dns)). So for the default
`*.spore.host` names, this warning doesn't mean DNS won't work.

### Exit codes and JSON

| Exit code | Meaning |
|---|---|
| `0` | No check failed (warnings are fine) |
| `1` | At least one check failed |

```sh
spawn doctor -o json
```

```json
{
  "ok": true,
  "summary": { "fail": 0, "pass": 13, "skip": 0, "warn": 3 },
  "checks": [
    { "name": "spawn version", "status": "pass", "detail": "0.135.0" }
  ]
}
```

- `status` is `pass`, `warn`, `fail` or `skip`.
- `detail` is the value found, and `fix` the hint. Each is left out when empty.
- `--json` still works, but is deprecated: use `-o json`.

Only failures change the exit code, so `spawn doctor` works as a gate in a
script: `spawn doctor && spawn launch …`.

## `spawn footprint`: what spawn has left in the account

`spawn footprint` lists everything spawn has created in an account, not just
instances. It's a report and **never deletes anything**.

```sh
spawn footprint                    # the current region, plus account-wide resources
spawn footprint --region eu-west-1
spawn footprint --all-regions      # every region enabled for the account
spawn footprint -o json
```

Use it to see what an account is carrying, for example before closing a
project or handing an account back. For day-to-day leftovers (volumes, security
groups, Elastic IPs), [`spawn orphans`](/guides/managing-instances#seeing-whats-running)
is faster.

### What it reports

The report has three sections:

| Section | What's in it | Found by |
|---|---|---|
| **Tagged spawn:managed** | Everything tagged `spawn:managed`, by anyone in the account: instances, volumes, security groups and so on. This is what `spawn cleanup` acts on | The tag, through the Resource Groups Tagging API |
| **Control plane, by region** | Lambda functions, CloudWatch log groups, EventBridge rules and DynamoDB tables. **Not** covered by `spawn cleanup` or the reaper | Name |
| **Global** | IAM roles, IAM instance profiles and S3 buckets, with their age | Name |

"Name" means the resource's name starts with `spawn`, `spore`, `spored`,
`lagotto` or `truffle`, or is one of a few known spore.host resources without a
prefix. Much of the control plane was created before spawn tagged it, so the
name is the only way to find it.

That has a blind spot: anything named differently doesn't appear. Treat the
name-matched rows as a minimum, not a complete list.

After the tables:
- **Worth a look** flags log groups with no retention setting (kept forever), and
  log groups whose Lambda function no longer exists. Deleting a function doesn't
  delete its log group.
- **Could not read** lists every service spawn couldn't query, usually for lack
  of permission. These are gaps in the report, not proof that nothing is there.
  The rest of the report still prints.

"Nothing found" means nothing tagged and nothing matching those names. It
doesn't mean the account is empty.

### Exit code and JSON

`spawn footprint` exits `0` when it produced a report, even with gaps under
"Could not read". It exits `1` only when it couldn't start, for example with
no credentials or no region.

`-o json` has the fields `regions`, `tagged`, `control_plane`, `global`, `notes`
(the "Could not read" gaps) and `warnings`.

### Permissions

Everything it calls is a read:

| Section | Actions |
|---|---|
| Tagged | `tag:GetResources` |
| Control plane | `lambda:ListFunctions`, `logs:DescribeLogGroups`, `events:ListRules`, `dynamodb:ListTables` |
| Global | `iam:ListRoles`, `iam:ListInstanceProfiles`, `s3:ListAllMyBuckets` |
| `--all-regions` | `ec2:DescribeRegions` |

## `spawn onboard`: connect an account to the portal

::: warning This one changes your account
`spawn onboard` creates an IAM role that lets the spore.host portal launch and
manage EC2 instances in your account. Then it registers that role with the
portal. Run it only in an account you mean to connect, with credentials for
that account.
:::

It's the command-line equivalent of the portal's CloudFormation quick-create.

```sh
spawn onboard
spawn onboard --skip-phone-home    # create the role, don't register it
spawn onboard -o json
```

### What it does

1. Looks up your account with STS.
2. Generates an **ExternalId** (32 random hex characters), unless you pass
   `--external-id`. The portal has to present it to assume the role.
3. Creates the IAM role **`spore-portal-onboard`**. Its trust policy lets only
   the portal's phone-home Lambda role assume it, and only with that ExternalId.
   It has two inline policies:
   - **`PortalEC2Launch`**: launch instances and read EC2, SSM sessions, quotas
     and prices. Every action that can affect an existing instance (stop, start,
     terminate, retag, open a session) requires `spawn:managed=true` on it.
   - **`PortalPassSporedProfile`**: `iam:PassRole` on the spored role only, and
     only to EC2.
4. Sends the role ARN, the ExternalId and the region to the portal. The
   request is signed with your credentials, so the portal knows which account it
   came from.
5. Prints the role ARN and the ExternalId. Keep the ExternalId.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--region` | Your profile's region, else `us-east-1` | The region sent to the portal. The role itself is account-wide |
| `--external-id` | A new random value | Use this ExternalId instead of generating one |
| `--skip-phone-home` | off | Create the role, but don't register it with the portal |
| `--phone-home-url` | spore.host's portal (or `SPORE_PORTAL_PHONE_HOME_URL`) | Where to register |
| `--phone-home-role` | spore.host's portal role (or `SPORE_PORTAL_PHONE_HOME_ROLE_ARN`) | The role the trust policy names |
| `--spored-role` | `spored-instance-role` | The role `iam:PassRole` is granted for |
| `--spored-profile` | | Deprecated alias for `--spored-role` |
| `--json` | | Deprecated: use `-o json` |

`-o json` prints `accountId`, `roleArn`, `externalId`, `region` and `caller`.

It exits `0` when it's done and `1` on any error.

### Running it again

If `spore-portal-onboard` already exists, `spawn onboard` leaves it exactly as it
is, trust policy and permissions included, and prints
`Role spore-portal-onboard already exists — leaving its trust policy unchanged.`

::: warning Known problems (spawn#1138)
These are in spawn v0.135.0:

- **Re-running without `--external-id` registers the wrong ExternalId.** The
  existing role keeps the ExternalId it was created with, but spawn generates a
  new one and sends that to the portal and prints it. The portal then can't
  assume the role. If you re-run, pass the original value with `--external-id`.
- **Re-running doesn't update the role's permissions.** A role created by an
  older spawn keeps its older policies. To pick up the current ones, delete the
  role ([below](#disconnecting-an-account)) and run `spawn onboard` again.
- **Registration is signed for the `--region` you pass**, but the portal's
  endpoint is in `us-east-1`. With any other region, registration is expected
  to be refused. Use `--skip-phone-home` and register in the portal instead.
- **`-o json` isn't clean JSON.** The progress lines (`Onboarding account …`,
  `✓ Role: …`) go to stdout before the JSON object.
:::

### Permissions

The identity running it needs `sts:GetCallerIdentity`, plus `iam:GetRole`,
`iam:CreateRole`, `iam:TagRole` and `iam:PutRolePolicy` on
`spore-portal-onboard`. Registration needs `lambda:InvokeFunctionUrl` on the
portal's endpoint.

### Disconnecting an account

There's no command for this yet
([spawn#457](https://github.com/spore-host/spawn/issues/457)). Removing the role
cuts off the portal's access:

```sh
aws iam delete-role-policy --role-name spore-portal-onboard --policy-name PortalEC2Launch
aws iam delete-role-policy --role-name spore-portal-onboard --policy-name PortalPassSporedProfile
aws iam delete-role --role-name spore-portal-onboard
```

Deleting the role doesn't remove the portal's record of the account; that's
what spawn#457 is about.

## See also

- [Required permissions](/reference/iam-permissions): the IAM baseline `spawn doctor` checks against.
- [Managing instances & data](/guides/managing-instances): `spawn resources`,
  `spawn orphans` and `spawn cleanup`.
- [Logs and debugging](/guides/logs): `spawn logs`, once an instance is running.
- [Troubleshooting & common mistakes](/reference/troubleshooting)
