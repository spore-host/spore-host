# EC2 Tags

spore.host tags every instance it launches with `spawn:*` tags. These tags drive lifecycle management, filtering, and cost tracking.

## Core tags

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:managed` | `true` | Marks this instance as spawn-managed. Used to filter in `spawn list`. |
| `spawn:created` | `2026-04-30T09:00:00Z` | ISO 8601 timestamp when the instance was launched. |
| `spawn:created-by` | `alice` | IAM username of the person who launched the instance. |
| `spawn:version` | `1.4.2` | Version of spawn that created the instance. |
| `spawn:arch` | `x86_64` | CPU architecture of the instance. |

## Lifecycle tags

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:ttl` | `12h` | Time-to-live. Instance terminates after this duration. |
| `spawn:ttl-remaining` | `8h23m` | Approximate time until TTL-based termination (updated by spored). |
| `spawn:on-complete` | `terminate` | Action when TTL expires: `terminate`, `stop`, or `hibernate`. |
| `spawn:idle-timeout` | `30m` | Terminate/stop if idle for this duration. |
| `spawn:hibernate-on-idle` | `true` | Hibernate (rather than terminate) when idle. |
| `spawn:session-timeout` | `2h` | Terminate if no SSH session for this duration. |
| `spawn:cost-limit` | `50.00` | Stop/terminate when cumulative cost exceeds this amount (USD). |

## Naming and purpose

| Tag | Example | Description |
|-----|---------|-------------|
| `Name` | `ml-training` | Human-readable instance name (standard AWS `Name` tag). |
| `spawn:dns-name` | `ml-training.a1b2c3.spore.host` | Assigned DNS hostname. |
| `spawn:purpose` | `GPU training run` | Free-text description set at launch. |
| `spawn:iam-user` | `alice` | IAM user identifier (may differ from `created-by` in federated environments). |

## Notification tags

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:notify-url` | `https://hooks.slack.com/...` | Webhook URL for lifecycle notifications. |
| `spawn:slack-workspace-id` | `T03NE3GTY` | Slack workspace to notify. |
| `spawn:notify-command` | `/usr/local/bin/notify.sh` | Local command to run on lifecycle events. |

## Parameter sweeps

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:sweep-id` | `sweep-abc123` | Identifies which sweep this instance belongs to. |
| `spawn:sweep-name` | `lr-search` | Human name of the sweep. |
| `spawn:sweep-size` | `16` | Total number of instances in the sweep. |
| `spawn:sweep-index` | `3` | Zero-based index of this instance in the sweep. |
| `spawn:step` | `lr=0.001` | Parameter value(s) for this step. |

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
| `spawn:root` | `i-0abc123` | Instance ID of the cluster head node. |

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

| Tag | Example | Description |
|-----|---------|-------------|
| `spawn:fsx-stack-name` | `spawn-fsx-abc` | CloudFormation stack managing the FSx filesystem. |
| `spawn:fsx-storage-capacity` | `1200` | FSx storage size in GiB. |
| `spawn:fsx-import-path` | `s3://bucket/input/` | S3 path FSx imports from. |
| `spawn:fsx-export-path` | `s3://bucket/output/` | S3 path FSx exports to. |

## Filtering instances

Use tags with `spawn list` or the AWS CLI:

```sh
# List only your instances
spawn list --filter owner=alice

# AWS CLI: find all spawn-managed instances
aws ec2 describe-instances \
  --filters "Name=tag:spawn:managed,Values=true" \
  --query 'Reservations[].Instances[].{ID:InstanceId,Name:Tags[?Key==`Name`].Value|[0]}'
```
