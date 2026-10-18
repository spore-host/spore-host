---
description: "spore.host tags every instance it launches with spawn: tags."
---

# EC2 Tags

spore.host tags every instance it launches with `spawn:*` tags. These tags drive lifecycle management, filtering, and cost tracking.

## Core tags

Written on every instance spawn launches.

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:managed` | `true` | Marks this instance as spawn-managed. Used to filter in `spawn list`. |
| `spawn:root` | `true` | Always `true` on every instance spawn launches. |
| `spawn:created-by` | `spawn` | Always the literal `spawn`, not a user name. Use `spawn:iam-user` for who launched it. |
| `spawn:iam-user` | `arn:aws:iam::123456789012:user/alice` | ARN of the IAM identity that launched the instance. |
| `spawn:account-id` | `123456789012` | AWS account the instance runs in. |
| `spawn:account-base36` | `1kpqzg2c` | The account ID in base 36, used as the account segment of the DNS name. |
| `spawn:version` | `0.135.0` | Version of spawn that created the instance. |
| `spawn:launch-time` | `2026-04-30T09:00:00Z` | Original launch time (RFC 3339). Unlike EC2's `LaunchTime`, it doesn't reset when a stopped instance starts again, so it anchors the TTL. |

`spawn:created` (an RFC 3339 timestamp) and `spawn:arch` are not instance tags.
`spawn:created` is on the network resources spawn creates (security groups,
placement groups), where the reaper reads it to judge their age; `spawn:arch` is
on AMIs spawn builds.

## Lifecycle tags

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:ttl` | `12h` | Total time-to-live, measured from `spawn:launch-time`. |
| `spawn:ttl-deadline` | `2026-04-30T21:00:00Z` | **Authoritative** termination deadline, written together with `spawn:ttl`. This is what spored and the [TTL reaper](/guides/reaper) enforce. It keeps counting while the instance is stopped; `spawn extend` moves it. |
| `spawn:on-complete` | `terminate` | Action when the workload signals completion: `terminate`, `stop`, or `hibernate`. It has nothing to do with the TTL: TTL expiry always terminates. |
| `spawn:completion-file` | `/tmp/SPAWN_COMPLETE` | File whose appearance signals completion. Written only when `spawn:on-complete` is set. |
| `spawn:idle-timeout` | `30m` | Stop (or hibernate) if idle for this duration. Never terminates. |
| `spawn:hibernate-on-idle` | `true` | Hibernate instead of stopping when idle (set by `--on-idle hibernate`). |
| `spawn:session-timeout` | `30m` | Auto-logout for idle shells (sets `TMOUT` for login shells). `0` disables it. It doesn't stop or terminate the instance. |
| `spawn:cost-limit` | `50.0000` | Terminate when cumulative **compute + EBS** cost reaches this amount (USD). Compute accumulates across stop/resume; EBS accrues on wall-clock time, including while stopped. FSx/EFS are not counted. |
| `spawn:price-per-hour` | `0.192000` | On-demand hourly rate, written at launch. spored computes cost and enforces `spawn:cost-limit` from it. |
| `spawn:price-source` | `live` | Where `spawn:price-per-hour` came from: `live` (the AWS Price List, at launch) or `static` (truffle's built-in fallback table). |
| `spawn:compute-seconds` | `5400` | Cumulative running seconds across stop/start cycles. Written by spored every few minutes. |

`spawn:ttl-remaining` is no longer written: spawn stopped writing it when
stopping an instance. You may still see it on instances stopped by an older spawn;
it's ignored apart from a notice on `spawn start`.

## Naming, DNS and purpose

| Tag | Example | Description |
|-----|---------|-------------|
| `Name` | `ml-training` | Human-readable instance name (standard AWS `Name` tag). |
| `spawn:dns-name` | `ml-training` | The DNS label to register, not a full hostname. spored registers `<label>.<account-base36>.<domain>` on start and removes it on shutdown. Absent with `--no-dns`. |
| `spawn:dns-domain` | `lab.example.org` | Zone to register under instead of `spore.host` (`--dns-domain`). Written only with `spawn:dns-name`. |
| `spawn:dns-endpoint` | `https://abc.lambda-url.us-east-1.on.aws/` | Custom DNS updater to register with (`--dns-api-endpoint`). Written only with `spawn:dns-name`. |
| `spawn:purpose` | `pipeline` | A short machine-readable kind, set by spawn on resources it creates for its own use (for example `pipeline`, `ssh-key`, `warm-build-seed`). Not a free-text description. |

## Notification tags

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:slack-workspace-id` | `T03NE3GTY` | Workspace to notify (`--slack-workspace`). Also used for Teams and Discord workspace IDs. |
| `spawn:notify-url` | `https://<id>.lambda-url.us-east-1.on.aws` | The spore-bot Lambda endpoint spored posts lifecycle events to. Set with `spawn:slack-workspace-id`; `SPORE_NOTIFY_URL` overrides it for self-hosted bots. |
| `spawn:notify-command` | `/spore` | Slash command that routes notifications to the right bot app config. spawn sets it to `/spore`; there is no launch flag for it. |
| `spawn:notify-platform` | `teams` | Chat platform: `slack` (the default when absent), `teams`, or `discord` (`--notify-platform`). |

## Parameter sweeps

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:sweep-id` | `sweep-abc123` | Identifies which sweep this instance belongs to. |
| `spawn:sweep-name` | `lr-search` | Human name of the sweep. |
| `spawn:sweep-size` | `16` | Total number of instances in the sweep. |
| `spawn:sweep-index` | `3` | Zero-based index of this instance in the sweep. |
| `spawn:step` | `preprocess` | Workflow step name, from a `step` key in the sweep parameters. |
| `spawn:param:<key>` | `0.001` | One tag per sweep parameter, in name order, up to AWS's 50-tag limit. The sweep manifest stays authoritative. |

## Job arrays

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:job-array-id` | `array-xyz` | Job array identifier. |
| `spawn:job-array-name` | `preprocess` | Human name of the array. |
| `spawn:job-array-size` | `8` | Total instances in the array. |
| `spawn:job-array-index` | `2` | Zero-based index of this instance. |

## MPI clusters

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:mpi-enabled` | `true` | This instance is part of an MPI cluster. |
| `spawn:mpi-processes-per-node` | `4` | Number of MPI processes to run on each node. |

## Pipelines

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:pipeline-id` | `pipe-def456` | Pipeline identifier. |
| `spawn:stage-id` | `stage-ghi789` | Current pipeline stage. |
| `spawn:stage-index` | `1` | Stage index (0-based). |

## Teams

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:team-id` | `team-jkl` | Team this instance belongs to. |
| `spawn:team-name` | `genomics-lab` | Human name of the team. |

## FSx (Lustre integration)

On the instance:

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:fsx-id` | `fs-0abc1234` | FSx filesystem ID — written at launch so instance scripts can auto-mount without hardcoding the ID. |
| `spawn:fsx-pending` | `fs-0abc1234` | A filesystem still being created (`--fsx-create`). spored waits for it, mounts it, then replaces this tag with `spawn:fsx-id`. |
| `spawn:fsx-mount-name` | `q5pdvb4v` | Per-filesystem Lustre mount name (from `LustreConfiguration.MountName`). Required for the mount command: `<dns>@tcp:/<mount-name>`. |
| `spawn:fsx-mount-point` | `/fsx` | Mount point for the FSx filesystem. |
| `spawn:fsx-s3-import-path` | `s3://bucket/input/` | S3 path FSx imports from. |
| `spawn:fsx-s3-export-path` | `s3://bucket/output/` | S3 path FSx exports to. |

On the filesystem itself (`--fsx-create`), spawn also writes `spawn:fsx-stack-name`,
`spawn:fsx-storage-capacity` (GiB), `spawn:fsx-s3-bucket` and `spawn:fsx-created`.

## EFS integration

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:efs-id` | `fs-0def5678` | EFS filesystem ID — written at launch so instance scripts can auto-mount. |
| `spawn:efs-mount-point` | `/efs` | Mount point for the EFS filesystem. |

## Filtering instances

Use tags with `spawn list` or the AWS CLI:

```sh
# List only the instances one IAM identity launched
spawn list --tag spawn:iam-user=arn:aws:iam::123456789012:user/alice

# AWS CLI: find all spawn-managed instances
aws ec2 describe-instances \
  --filters "Name=tag:spawn:managed,Values=true" \
  --query 'Reservations[].Instances[].{ID:InstanceId,Name:Tags[?Key==`Name`].Value|[0]}'
```

## S3 object tags on task outputs

Outputs written by `spawn task run` carry S3 object tags that record what they
would cost to regenerate, so S3 lifecycle rules can tier them. See [Keeping
results](/guides/results-retention) for how they're used.

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:regen-class` | `cheap` | `cheap`, `moderate` or `expensive`, from the run's cost and duration. Absent when no rate was known. |
| `spawn:regen-usd` | `0.0500` | What the run cost, in USD. |
| `spawn:regen-hours` | `0.5000` | How long the run took, in hours. |
| `spawn:run-id` | `3f6c2a1e-…` | ID of the run that wrote the output (a UUID). |
| `spawn:retain` | `false` | Always `false` at upload. Set it to `true` (with `spawn results retain`) to keep an output out of every tiering rule. |
| `spawn:regenerable` | `true` | Present only when the task spec opted in to future deletion. |
