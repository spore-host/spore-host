# portal-account-prober — OpenTofu module

The **scheduled caller** of the BYOA account lifecycle state machine (spawn#457).
Every run it scans the `spore-portal-accounts` registry, assumes each account's
`spore-portal-onboard` role, counts `spawn:managed` instances across every region,
and writes back only the lifecycle transitions the state machine decided.

Runs in the **infra account `966362334030`** (the control plane), alongside
`dns-updater`, `spore-bot`, and `portal-phone-home`. **Fresh apply**, not
import-onto-live.

Function logic: [`lambda/portal-account-prober/`](../../../lambda/portal-account-prober/).
The state machine it calls: [`lambda/accountlifecycle/`](../../../lambda/accountlifecycle/).

## What it manages

- `aws_iam_role.prober` (**`PortalAccountProberLambdaRole`**) — the execution role.
  Its ARN is the value that goes into the onboarding template (see *Rollout* below).
- `aws_iam_role_policy.runtime` — `dynamodb:Scan`+`UpdateItem` on the registry,
  `sts:AssumeRole` on the onboard role, KMS on both CMKs, X-Ray.
- `aws_lambda_function.prober` — the function **shape** (arm64, `provided.al2023`,
  256 MB, 300 s). Code is deployed out-of-band via the Lambda's Makefile;
  `ignore_changes` covers the code attributes.
- `aws_cloudwatch_event_rule.schedule` + target + `aws_lambda_permission` — the
  function's **only** invoker.
- Two CMKs (`portal-account-prober-env`, `portal-account-prober-logs`), the log
  group, and two alarms.

The registry table and its CMK are **data sources**, not resources — they belong to
the `portal-phone-home` module, so there stays exactly one table definition.

## The security decision this module encodes

The prober needs `sts:AssumeRole` into every onboarded customer account. That is a
genuinely powerful grant, and the point of a separate function is to keep it away
from the two places it could otherwise have gone — the internet-facing phone-home
Lambda, and spawn's ttl-reaper (which assumes a different, hand-maintained role set
and would have had to probe accounts it holds no credentials for). The module header
in `main.tf` has the full argument.

The grant is narrowed two ways:

**Resource: `arn:aws:iam::*:role/spore-portal-onboard`.** The wildcard is in the
*account* field only, and it has to be — the set of onboarded accounts is data in
DynamoDB, discovered at runtime, so it cannot be enumerated in a policy written
before those accounts onboard. What *is* pinned is the role **name**: this grant
cannot assume any other role in any account. The real authorization is on the far
side and not ours to weaken — each customer's trust policy must name this role *and*
require their per-account ExternalId, so a wildcard here grants nothing an account
hasn't separately agreed to. Narrowing it further would mean a Tofu apply per
customer onboard.

semgrep flags it as `no-iam-creds-exposure`, which is a fair description —
`sts:AssumeRole` returns credentials by definition, and there is no narrower action
that does the job. The suppression is on the action being inherently
credential-returning, **not** on the resource scope. If the resource ever loosens
past a single pinned role name, that justification no longer holds and must be
re-argued.

**A read-only STS session policy on every assume.** `spore-portal-onboard` is a
launch role, and a trust policy says who may assume rather than what they may then
do — so the credentials are capped at `ec2:DescribeInstances` in the function
itself. See the Lambda's README; that is what makes the trust grant honest to ask
for.

**No PutItem, no DeleteItem** on the table. A Put would clobber a concurrent
re-onboard's fresh `externalId`/`roleArn` with the stale copy this run happened to
read; offboarding is a status transition and the row is the audit trail.

## Alarms

**`portal-account-prober-refused-correlated-failure`** is the one that matters. The
state machine changing nothing when every probe fails is correct but *silently*
correct: a run that concludes nothing because our own credentials or trust broke is
indistinguishable, from the outside, from a run with nothing to do. The handler logs
`REFUSING to conclude anything` on that path precisely so it can be alarmed on. When
this fires, investigate **our** side — the execution role, the assume-role grant, the
onboarding template's trust policy — not the customers. It firing means the safety
guard worked; it is not an incident about accounts.

**`portal-account-prober-errors`** covers the runs that fail outright (e.g. the
registry Scan threw) and so never reach the refusal path at all.

Log-group encryption uses its own CMK rather than the env key, because the key
*policy* must grant `logs.<region>.amazonaws.com` — scoped by
`kms:EncryptionContext:aws:logs:arn` to this one log group — and that is a grant the
env key has no business carrying. Worth encrypting at all because these logs name
every onboarded customer account id alongside its lifecycle verdict: a customer list
plus a churn signal.

## Deploy

```sh
cd infra/tofu/portal-account-prober
cp terraform.tfvars.example terraform.tfvars    # keeps dry_run = true
# placeholder.zip is gitignored (it is not real code) but the function resource
# needs SOME valid archive to create. A zero-byte file is not one:
printf placeholder > bootstrap && zip placeholder.zip bootstrap && rm bootstrap
tofu init
tofu apply                                       # role, function shape, schedule, alarms
# then deploy the code:
cd ../../../lambda/portal-account-prober
make upload
aws lambda update-function-code --function-name portal-account-prober \
  --s3-bucket spawn-binaries-us-east-1 --s3-key portal-account-prober/function.zip \
  --profile spore-host-infra
```

## Rollout

`dry_run` defaults to **true** on purpose, and the order matters.

1. **Apply with `dry_run = true`.** The prober probes and decides normally but
   persists nothing, so the first runs can be read from CloudWatch before any
   account's status changes.
2. **Read the logs.** Every account onboarded before this module existed has a trust
   policy naming only the phone-home role, so it will *deny* the prober — with the
   same `AccessDenied` STS uses for a role that was deleted. What you are confirming
   is that those show up as denied-with-no-baseline (left strictly alone) rather than
   as accounts marching toward `unreachable`. The state machine guarantees this via
   `LastSeenAt`; dry-run is how you check it rather than assume it.
3. **Paste the `role_arn` output into `portal-onboarding-role.yaml`'s
   `ProberLambdaRoleArn` parameter** and re-upload the template to the website
   bucket, so newly onboarded accounts admit the prober. Existing stacks can be
   updated to add it; the parameter is optional and blank is safe.
4. **Set `dry_run = false`** and apply.

Note what step 3 does *not* do: it cannot retroactively fix already-deployed stacks.
Those accounts stay permanently denied-with-no-baseline — which is safe (nothing is
ever concluded about them) but means their DNS records are never eligible for
automatic expiry until they re-onboard.

## Variables

| Variable | Default | Notes |
|---|---|---|
| `dry_run` | `true` | decide and log, persist nothing |
| `schedule_expression` | `rate(1 hour)` | **K is counted in runs**, so this sets how long K failures take |
| `onboard_role_name` | `spore-portal-onboard` | must match the CFN template's `RoleName` |
| `accounts_table` | `spore-portal-accounts` | owned by the phone-home module |

`schedule_expression` is coupled to policy, not just cost. `accountlifecycle` counts
K in **runs**, so K=6 means six hours here and one hour at the reaper's
`rate(10 minutes)`. Hourly is deliberate: unreachability is not urgent — nothing is
deleted on the strength of it — and the per-run cost is ~11 `DescribeInstances` per
onboarded account.

`onboard_role_name` mismatching the template denies every probe. That fails
*visibly* rather than dangerously (the state machine refuses to interpret a
total failure, and the alarm above fires), but it also means the prober does nothing.

## State

Remote, in the infra account's state bucket (`portal-account-prober/terraform.tfstate`),
locked with an S3 lock file (#580). **No state has been written for
this root yet**: import its resources before the first `plan`. Credentials and
the import rule: [`../README.md`](../README.md). Never commit state.
