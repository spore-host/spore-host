---
description: "The TTL reaper is a scheduled Lambda that reclaims expired spawn instances, orphaned filesystems and leaked Spot requests from outside the instance. How to deploy it in your own account, arm it, keep it current and remove it."
---

# The TTL reaper: an out-of-band backstop

spored is the daemon on each instance, and it enforces the instance's TTL, idle
timeout and cost limit from the inside. That covers almost everything, but not all
of it:
- a **stopped** instance runs no spored, so nothing on it can terminate it at its TTL;
- a filesystem that outlives its instance (an `--fsx-lifecycle ephemeral` FSx) has no
  spored at all;
- if spored crashes, or never installs, nothing on the instance enforces anything.

The reaper is the second layer. It's a Lambda on a schedule that reads the same
`spawn:*` tags spored does, and reclaims what's past its deadline from outside the
instance. It's a backstop, not a replacement. spored stays the graceful enforcer: it
runs your pre-stop hook, removes DNS and stops or terminates according to your
settings. The reaper only catches what spored missed.

This guide covers what it checks, how to deploy it in your own account with
`spawn reaper`, how Spot requests are handled, and how to keep it current.
[Costs & safety guarantees](/safety) explains where it fits in spawn's overall
guarantee.

::: warning It's off until you deploy it
The plain CLI gives you in-instance enforcement only. Nothing out-of-band runs in your
account until you deploy a reaper, and once you deploy one it does nothing destructive
until you arm it. `spawn doctor` tells you which state you're in (the
`TTL reaper backstop` check).
:::

## What it checks

Every run, the reaper scans each configured region for instances tagged
`spawn:managed=true` that are `pending`, `running`, `stopping` or `stopped`. It
reclaims an instance when **either** of these is true:

1. **The deadline has passed.** `now` is after `spawn:ttl-deadline`. If that tag is
   missing or unparseable, it uses `spawn:launch-time` + `spawn:ttl`, which is the
   deadline spored enforces in that case.
2. **The instance is older than the max-age ceiling.** `now - spawn:launch-time` is
   more than `REAPER_MAX_AGE`, which is **168h (7 days)** by default. If
   `spawn:launch-time` is missing, EC2's own launch time is used.

The ceiling applies **even when the deadline is still in the future**. The instance
can write its own `spawn:ttl-deadline` tag, so a deadline set far into the future
would otherwise make an instance impossible to reap. A `--ttl` longer than 7 days is
therefore capped at 7 days, and `spawn launch` warns you when you ask for one. To
keep instances longer, raise `REAPER_MAX_AGE` on the reaper
(`spawn reaper deploy --max-age`, or the template's `MaxAge`).

Each run does the following:

| Check | What it reclaims or reports | How it's enabled |
|---|---|---|
| Instance deadline and max-age | Terminates the instance. If it came from a Spot request, the request is cancelled first (see [Spot requests](#spot-requests)) | Armed by `REAPER_DRY_RUN=false` |
| FSx filesystems | Deletes a spawn-managed FSx Lustre filesystem that no live instance references (through `spawn:fsx-id` or `spawn:fsx-pending`) and that is past its `spawn:ttl-deadline` or the max-age. An `ephemeral` filesystem more than 30 minutes old that no instance references counts as orphaned, deadline or not. A filesystem whose export to S3 hasn't caught up is held back | Armed by `REAPER_DRY_RUN=false` |
| Network resources | Deletes spawn-managed security groups and cluster placement groups that no instance references and that are older than 7 days. One with no `spawn:created` stamp gets a `spawn:reaper-first-seen` tag and is reclaimed 30 days after that | `REAPER_NET_RESOURCES`: `report` (default), `reap` or `off` |
| Persistent Spot requests | Cancels orphaned requests and terminates the replacements they launched | `REAPER_SPOT_REQUESTS`: `report` (default), `reap` or `off` |
| spored heartbeat | Counts running instances whose `spawn:last-heartbeat` is more than 10 minutes old, and logs `SPORED NOT CHECKING IN`. A stale heartbeat means spored started and then died. **Never** a reason to reap on its own | Always on, report only |
| DNS records | Deletes a reaped instance's Route 53 records. Optional sweeps remove records with no live instance behind them, or whose lease is stale | Only when a hosted zone is configured; see the [reaper README](https://github.com/spore-host/spawn/tree/main/lambda/ttl-reaper#readme) |

What it doesn't do:
- It ignores instances that aren't tagged `spawn:managed=true`. If someone deletes that
  tag, the reaper can't see the instance.
- By default it doesn't run your pre-stop hook. A reaper kill is a plain
  `TerminateInstances`. There's an opt-in that first tries the hook over SSM
  (`REAPER_GRACEFUL=true`), and it terminates either way.

### Dry run, report and reap

`REAPER_DRY_RUN` is the master switch. While it's `true`, the reaper logs
`WOULD reap …` for every instance and filesystem it would reclaim, and touches nothing.
Once it's `false` the instance and FSx checks act, and their log lines read `REAPED …`.

The network-resource and Spot-request sweeps each have their own three-way setting.
`report` logs what the sweep would do, `reap` acts, and `off` skips the sweep. They're
separate from `REAPER_DRY_RUN` on purpose: turning on a new destructive sweep shouldn't
mean disarming the instance reaper, and the instance reaper shouldn't start a new sweep
just by being upgraded. An unrecognised value counts as `report`. `REAPER_DRY_RUN=true`
always wins, so in a dry run nothing is deleted whatever these say.

## Deploy it in your own account

`spawn reaper` installs the reaper in the account your credentials point at. That
reaper scans only that account. Its role trusts only Lambda, so no other account,
including spore.host's, gets access to yours.

### 1. Check what covers you today

```sh
spawn doctor
spawn reaper status
```

### 2. Deploy it (unarmed)

```sh
spawn reaper deploy --regions us-east-1,us-west-2
```

This creates the following, all in the deploy region:

| Resource | Name |
|---|---|
| Execution role | `spawn-ttl-reaper-selfscan-role` |
| Its inline policy | `spawn-ttl-reaper-selfscan-policy`, plus the AWS-managed `AWSLambdaBasicExecutionRole` for logs |
| Artifact bucket | `spawn-reaper-artifacts-<account>-<region>`, tagged `spawn:managed=true` |
| Log group | `/aws/lambda/spawn-ttl-reaper-selfscan`, with a 30-day retention (`--log-retention-days`) |
| Lambda function | `spawn-ttl-reaper-selfscan` (arm64, `provided.al2023`, 256 MB, 900 s timeout) |
| EventBridge rule | `spawn-ttl-reaper-selfscan-schedule` |

The log group is created before the function, because the one Lambda would create on
the first run has no retention and keeps its logs forever. (Before spawn v0.136.0,
`spawn reaper deploy` set no retention.)

The flags:
- `--regions`: the comma-separated regions to scan. For a new reaper **the default is
  the deploy region only**, so list every region you launch in. On a re-deploy the
  default is the regions the existing reaper already scans.
- `--schedule`: an EventBridge schedule expression. The default is
  `rate(10 minutes)`.
- `--spot-requests` and `--net-resources`: `off`, `report` or `reap`, for the
  [Spot request sweep](#the-spot-request-sweep) and the network-resource sweep
  (`REAPER_SPOT_REQUESTS` and `REAPER_NET_RESOURCES`). The reaper's default for both
  is `report`.
- `--max-age`: the max-age ceiling, `REAPER_MAX_AGE`, such as `336h` or `14d`. The
  reaper's default is 7 days.
- `--notify-url`: an http(s) URL the reaper POSTs its notifications to
  (`REAPER_NOTIFY_URL`). spawn never prints it. Pass `-` to read it from stdin, so it
  doesn't appear on the command line or in your shell history.
- `--log-retention-days`: how long CloudWatch keeps the reaper's logs. The default is
  30. It must be a value CloudWatch accepts (1, 3, 5, 7, 14, 30, 60, 90, …). Below 30,
  [`teardown --if-idle-for`](#removing-it) can see only that much history.
- `--version`: the spawn release to take the Lambda from. The default is your CLI's
  version. The zip is downloaded from that GitHub release
  (`ttl-reaper_lambda_linux_arm64.zip`).
- `--artifact`: a local path or URL to use instead of the release download, for
  mirrored or air-gapped environments.
- `--bucket`: an existing bucket in this account to hold the zip. A bucket spawn didn't
  create isn't tagged, and teardown won't remove it.
- `--region`: the region to deploy into. The default is your resolved region.

```sh
spawn reaper deploy --region eu-west-1 --regions eu-west-1,eu-central-1 --schedule "rate(30 minutes)"
```

The four `REAPER_*` flags are checked against what the reaper accepts before anything
is created or changed. Each sets its variable only when you pass it. An empty value
(`--max-age ""`) removes the variable, which returns the reaper to its default:

```sh
spawn reaper deploy --spot-requests reap --max-age 14d
printf '%s\n' "$REAPER_WEBHOOK" | spawn reaper deploy --notify-url -
```

### 3. Read a dry-run cycle

Each run logs what it would reclaim:

```sh
aws logs tail /aws/lambda/spawn-ttl-reaper-selfscan --follow --region us-east-1
```

Look for `WOULD reap` lines. Each one names the instance, the account (`self` for
this deployment), the region, the reason (`ttl-deadline`, `ttl` or `max-age`), the
instance's age and its deadline. Each run ends with a `ttl-reaper done in …` summary
line holding the counts. To run it now instead of waiting for the schedule:

```sh
aws lambda invoke --function-name spawn-ttl-reaper-selfscan --region us-east-1 response.json
```

### 4. Arm it

```sh
spawn reaper arm
```

This asks you to type `yes`; `--yes` skips the question. It sets `REAPER_DRY_RUN=false`.
From the next run, the reaper terminates expired `spawn:managed` instances and deletes
orphaned spawn-managed FSx filesystems. **Termination can't be undone.**

Arming doesn't change the network-resource and Spot-request sweeps. They stay at
`report` until you set them with `spawn reaper deploy --net-resources` and
`--spot-requests`. A value you set directly on the function's environment is kept
by later deploys too.

### 5. Check on it

```sh
spawn reaper status
```

```text
TTL reaper in account 123456789012 (us-east-1)
  Function:  spawn-ttl-reaper-selfscan
  Version:   0.136.0
  State:     ARMED — it reclaims expired spawn-managed resources
  Schedule:  rate(10 minutes) (enabled)
  Scanning:  us-east-1,us-west-2
```

If the schedule rule is disabled, `Schedule` says `DISABLED — it will not run`. That
matters because an armed reaper that never runs protects nothing. If the reaper has run
and reclaimed nothing, `status` says for how long, measured as described under
[`--if-idle-for`](#removing-it). That's what a protected account with nothing expired
looks like, and it's also how you'd know the reaper isn't needed any more.

`spawn reaper status` only knows about the reaper `spawn reaper deploy` creates
(`spawn-ttl-reaper-selfscan`). In an account covered by a
[template deployment](#covering-several-accounts), it reports `NOT DEPLOYED`
([spawn#1157](https://github.com/spore-host/spawn/issues/1157)). Use
`spawn doctor` there, which detects both.

## Keeping it current

The CLI and a deployed reaper are versioned **independently**. Upgrading spawn doesn't
touch a reaper that's already in an account, so over time the reaper falls behind the
CLI. That's normal. An older reaper still reaps, but it lacks whatever fixes and checks
came later. `spawn reaper status` reads the function's `spawn:version` tag and says when
the two differ:

```text
  Version:   0.131.1
             this CLI is 0.136.0 — they are deployed independently, so re-run `spawn reaper deploy` to put 0.136.0 in the account
```

There's no separate upgrade command. To upgrade, run `deploy` again:

```sh
spawn reaper deploy --regions us-east-1,us-west-2
```

A re-deploy keeps the existing reaper's settings: its armed state, the regions it
scans, and every `REAPER_*` variable on the function, including any you set by hand,
unless a flag on this run sets it. Two things are applied fresh on every deploy,
though: the schedule (`--schedule`, default `rate(10 minutes)`) and the log
retention (`--log-retention-days`, default 30). Pass them again if you changed them.
(Before spawn v0.136.0, a re-deploy kept only the armed state, reset the regions to
the deploy region and dropped every other `REAPER_*` setting.) Each version's zip is
stored under its own key (`ttl-reaper/v<version>.zip`), so the bucket holds one zip
per version you've deployed until teardown.

## Warnings at launch

Most launches don't depend on the reaper, because spored terminates the instance from
inside. Two kinds do, and for those `spawn launch` checks for a reaper first:
- `--on-complete stop` or `--on-complete hibernate`: once the workload finishes, the
  instance is stopped and spored can't act. Its EBS volumes, and any Elastic IP, keep
  billing.
- `--fsx-lifecycle ephemeral`: the reaper is the only thing that deletes the
  filesystem.

If it finds no reaper, the launch goes ahead and prints a warning to stderr that starts
"No out-of-band TTL reaper covers this account, and:" and names what won't be
reclaimed. If the check itself couldn't finish (for example, because you lack
permission to list functions), the warning starts "Could not confirm an out-of-band
TTL reaper covers this account" instead.

The check, which `spawn doctor` also uses, counts the account as covered when it finds
either of these:
- a Lambda function whose name starts with `spawn-ttl-reaper` in the region you're
  launching in;
- an IAM role named `spawn-ttl-reaper-ec2`, which is what a
  [template deployment](#covering-several-accounts) creates in each account it covers.

It doesn't check which regions that reaper scans. If you launch in a region missing
from `--regions`, add the region and re-deploy.

## Spot requests

A `--spot` launch whose lifecycle can stop the instance (an idle timeout,
`--on-idle`, `--on-complete stop|hibernate`, `--hibernate`) makes a **persistent** Spot
request, because EC2 can only stop a Spot instance that came from one (since spawn
v0.129.0). A terminate-only lifecycle still makes a one-time request, and so does
an idle timeout that terminates (`spawn service`, pool workers and `spawn burst`
members) when nothing else could stop the instance. The request
expires at the instance's TTL deadline, or at launch plus 7 days when there's no TTL
(since v0.131.0).

A persistent request has a catch. If its instance is terminated, the request reopens
and EC2 launches a **replacement**. Every spawn path that terminates an instance
(`spawn terminate`, spored's own TTL, the reaper) cancels the request first, so this
doesn't happen in normal use. It does happen when an instance is terminated outside
spawn: from the EC2 console, or with `aws ec2 terminate-instances`. The replacement
carries none of spawn's tags. That means it has no TTL, `spawn list` doesn't show it,
and the reaper's instance scan can't see it. It bills until someone notices, and if it
gets terminated the same way, the request launches another.

### The Spot request sweep

The reaper looks at spawn-tagged persistent requests (since v0.131.0). It cancels a
request when:
- the request is open, nothing has launched from it, and it's more than 15 minutes old;
- its instance is terminated or no longer exists;
- its instance is a replacement, meaning it lacks `spawn:managed=true` or isn't the
  instance named in the request's `spawn:original-instance-id`;
- its original instance is past its deadline or the max-age ceiling.

When the instance is a replacement, the reaper also terminates it, always after
cancelling the request, because terminating first would reopen it. The reaper never
cancels a live original instance's request because of the request's own deadline tag.
`spawn extend` doesn't update that tag, so it can be out of date, and cancelling the
request would leave the instance unable to restart after its next stop.

The setting is `REAPER_SPOT_REQUESTS` (`spawn reaper deploy --spot-requests`, or the
`SpotRequests` template parameter), and it takes `report` (the default), `reap` or
`off`. In `report` mode it logs
`WOULD cancel orphaned spot request …` and acts on nothing. In `reap` mode it logs
`CANCELLED orphaned spot request …` and `TERMINATED spot replacement …`. If you set a
notification webhook (`REAPER_NOTIFY_URL`, `--notify-url`), it's notified either way.

### Replacements the reaper can't terminate

The reaper can only terminate instances tagged `spawn:managed=true`, and a replacement
has no tags. IAM has no condition key that links an instance to the Spot request that
launched it, so this grant can't be widened safely: a terminate grant without the tag
condition would let the reaper end instances spawn doesn't own. So the reaper still
cancels the request, which means nothing further launches, and then reports the
replacement for a person to end. It logs a line starting
`SPOT REPLACEMENT NOT TERMINATED`, which names the account, region and instance, a
`describe-instances` command to confirm it's the request's instance, and the
`terminate-instances` command to end it. That line repeats every run until the instance
is gone. It's posted to the webhook once.

### Replacements that retire themselves

A replacement boots from the original's launch specification, so it runs spawn's
bootstrap and spored under spawn's role. spored now uses this (since v0.131.0). At
startup it checks whether it's on a replacement: an instance without
`spawn:managed=true` whose Spot request is a spawn persistent request naming a
different original instance. If it is, the Linux bootstrap skips your `--command`, and spored
logs `SPOT REPLACEMENT DETECTED`, sends a `spot_replacement_retired` notification
through the original's notification settings, and cancels the request. If anything
can't be read, it does nothing, and the reaper's report still applies.

Since **v0.131.1**, spored then **terminates the instance itself**. Before that it shut
the OS down, which with EC2's default shutdown behaviour only stops the instance,
leaving it untagged and still billing for EBS. The spored role carries a grant that
lets an instance terminate itself and nothing else. A role created before v0.131.1
lacks it, and then spored falls back to the shutdown and logs the command to finish the
job by hand. Any `spawn launch` refreshes the spored role.

See also [Spot Instances](/guides/spot-instances).

## Removing it

```sh
spawn reaper teardown
```

This removes the schedule rule and its target, the invoke permission, the function,
the role and its policies, the log group, and the artifact bucket. The bucket is
removed only if it's tagged `spawn:managed=true` **and** holds nothing outside
`ttl-reaper/`. Otherwise teardown keeps it and says why.
- `--keep-logs` leaves the log group, `/aws/lambda/spawn-ttl-reaper-selfscan`. It's
  the only record of what the reaper did.
- `--keep-artifacts` leaves the bucket in place.
- `--force-artifacts` removes the bucket even if it isn't tagged, for buckets created
  before the tag existed. It still refuses a bucket holding anything outside
  `ttl-reaper/`.
- `--if-idle-for <duration>` tears down only if the reaper looks idle. Otherwise it
  reports why and exits 0. If idleness can't be determined, or the reaper hasn't run
  at all, it never tears down. That makes it safe to schedule:

```sh
spawn reaper teardown --if-idle-for 720h
```

The check reads the last 30 days of the reaper's logs. The reaper counts as idle when
it ran in that window and logged no action: no instance or filesystem `REAPED`, Spot
request `CANCELLED`, replacement `TERMINATED` or DNS record `EXPIRING`. It has been
idle since its first run still in the logs, or since this deployment was created (its
role's creation date), whichever is later. So a reaper deployed an hour ago has been
idle for an hour, not 30 days. Because the logs go back 30 days at most, a duration
over `720h` never triggers a teardown. (Before spawn v0.136.0, any reaper that had run
without reaping counted as idle for the full 30 days, and only `REAPED` counted as
work.)

What teardown leaves behind:
- the log group, if you pass `--keep-logs`. Before spawn v0.136.0, teardown always
  left it;
- a bucket you named with `--bucket` at deploy time, since teardown only looks for the
  default bucket name ([spawn#1157](https://github.com/spore-host/spawn/issues/1157));
- the `spawn:reaper-first-seen` tags it wrote on security groups and placement groups.

Before v0.127.0, teardown deliberately kept the artifact bucket. If you tore down with
an older CLI, the bucket may still be there.

## Covering several accounts

A spore lands in whichever account the caller's credentials point at, so a reaper
must cover every account that launches spores. `spawn reaper deploy` covers one
account per deployment, and that's the simplest arrangement. Alternatively, a single
central reaper can cover several accounts by assuming a role in each. This is the
SAM template in
[`lambda/ttl-reaper/`](https://github.com/spore-host/spawn/tree/main/lambda/ttl-reaper),
deployed with `make deploy`. The member accounts must trust the reaper's account, so
check your organization's policy on cross-account trust first.

In each member account, deploy the role template from the spawn repo with **your**
reaper account's ID. The template's default points at spore.host's own account, so
don't omit it:

```sh
aws cloudformation deploy --template-file deployment/cloudformation/ttl-reaper-cross-account-role.yaml --stack-name spawn-ttl-reaper-ec2 --region us-east-1 --capabilities CAPABILITY_NAMED_IAM --parameter-overrides ReaperAccountId=123456789012
```

This creates `spawn-ttl-reaper-ec2`. It trusts roles in the reaper account whose names
match `spawn-ttl-reaper-*`, with the external ID `spawn-ttl-reaper`. It grants the
same actions as the in-account policy, with the same `spawn:managed=true` conditions.
The one difference is that it also tag-conditions `fsx:DeleteFileSystem`.

Then, from `lambda/ttl-reaper/` in the reaper account, deploy the reaper with every
member role. It needs Go, the SAM CLI and Python 3. Start in dry run:

```sh
make deploy DRY_RUN=true ROLE_ARNS='arn:aws:iam::111111111111:role/spawn-ttl-reaper-ec2,arn:aws:iam::222222222222:role/spawn-ttl-reaper-ec2'
```

Always pass `ROLE_ARNS` on a first deploy. Its default names a spore.host account.

On later runs, `make deploy` reads the live stack's parameters first and keeps any you
don't pass, so you only name what you're changing. For example, to arm the reaper and
turn on the Spot request sweep:

```sh
make deploy DRY_RUN=false SPOT_REQUESTS=reap
```

The template exposes these as parameters, with their `make` variables:
- `MaxAge` (`MAX_AGE`, default `168h`);
- `Regions` (`REGIONS`, default the 11 regions spawn publishes spored to);
- `Schedule` (`SCHEDULE`);
- `NetResources` (`NET_RESOURCES`) and `SpotRequests` (`SPOT_REQUESTS`);
- `NotifyUrl` (`NOTIFY_URL`);
- the DNS settings.

It also creates CloudWatch alarms on the reaper's own failures (on by default; send them
to an SNS topic with `ALARM_TOPIC_ARN`) and a log group with 30-day retention. A
`spawn reaper deploy` reaper has the log group but no alarms. The
[reaper README](https://github.com/spore-host/spawn/tree/main/lambda/ttl-reaper#readme)
lists every setting and alarm.

## Permissions

The reaper's own role gets read access to instances, Spot requests, security groups,
placement groups and FSx filesystems. Its destructive actions are
`ec2:TerminateInstances`, `ec2:CancelSpotInstanceRequests`, `ec2:DeleteSecurityGroup`,
`ec2:DeletePlacementGroup` and `ec2:CreateTags`, all conditioned on
`spawn:managed=true`, plus `fsx:DeleteFileSystem` and an `ssm:SendCommand` grant for
the optional graceful pre-stop.
In this in-account policy `fsx:DeleteFileSystem` is **not** tag-conditioned. The reaper's own check (it
deletes only a filesystem tagged `spawn:managed` that nothing references) is the only
guard there.

The person running `spawn reaper` needs permission for the calls it makes. This list
comes from the code, not from a tested minimal policy:
- **`deploy`**: `iam:GetRole`, `iam:CreateRole` (with tags), `iam:PutRolePolicy`,
  `iam:AttachRolePolicy` and `iam:PassRole` on the reaper role;
  `s3:CreateBucket`, `s3:PutBucketTagging`, `s3:PutObject` and access to check the
  bucket exists; `logs:CreateLogGroup`, `logs:TagResource` (the group is created with
  tags) and `logs:PutRetentionPolicy` on the reaper's log group;
  `lambda:GetFunction`, `lambda:CreateFunction`,
  `lambda:UpdateFunctionCode`, `lambda:UpdateFunctionConfiguration`,
  `lambda:TagResource` and `lambda:AddPermission`; `events:PutRule` and
  `events:PutTargets`.
- **`arm`**: `lambda:GetFunction` and `lambda:UpdateFunctionConfiguration`.
- **`status`**: `lambda:GetFunction`, `events:DescribeRule`, and for the idleness
  report `logs:FilterLogEvents` and `iam:GetRole` on the reaper role (its creation
  date bounds the answer).
- **`teardown`**: `events:RemoveTargets`, `events:DescribeRule`, `events:DeleteRule`,
  `lambda:RemovePermission`, `lambda:DeleteFunction`, `iam:DeleteRolePolicy`,
  `iam:DetachRolePolicy`, `iam:DeleteRole`, `logs:DeleteLogGroup` (unless
  `--keep-logs`), `s3:GetBucketTagging`, `s3:ListBucket`, `s3:DeleteObject` and
  `s3:DeleteBucket`. `--if-idle-for` also needs what `status` needs for idleness.

Every subcommand also calls `sts:GetCallerIdentity`. For spawn's other permissions,
see [IAM permissions](/reference/iam-permissions).

## What it costs

Nobody has measured the cost of running the reaper. What's known is its shape:
- one Lambda invocation per schedule tick, which is 144 a day at the default
  `rate(10 minutes)`, at 256 MB on arm64;
- each run's duration depends on how many regions it scans and how many spawn
  resources are in them, and it's capped by the 900-second timeout;
- CloudWatch Logs for each run's output, kept for `--log-retention-days` (30 by
  default);
- one zip in S3 per version deployed.

To see the actual cost, look up the function in your bill or Cost Explorer. A longer
`--schedule` reduces the cost, and it also lengthens how long an expired resource can
outlive its deadline.

## Related

- [Costs & safety guarantees](/safety): the two layers of enforcement and what each
  deployment mode guarantees
- [EC2 tags](/reference/ec2-tags): the `spawn:*` tags the reaper reads
- [Spot Instances](/guides/spot-instances)
- [Self-Hosting spore.host](/guides/self-hosting)
- [`spawn reaper` command reference](/tools/reference/spawn#spawn-reaper)
