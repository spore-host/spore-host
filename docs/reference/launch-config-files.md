---
description: "The three YAML files spore.host commands read to describe a launch, which command takes which, and every key each one accepts."
---

# Launch config files

Three commands take a YAML file that describes a launch. **They are three
different formats.** A file written for one is not valid for another, and the key
names only partly overlap.

| File | Read by | What it holds | Unknown keys |
|------|---------|---------------|--------------|
| [Plugin file](#spawn-launch-config) | `spawn launch --config` | Only a `plugins:` list | Error |
| [lagotto spawn-config](#lagotto-spawn-config) | `lagotto watch --spawn-config`, `lagotto launch --spawn-config` | The instance to launch when a watch matches or a schedule fires | Error (lagotto v0.65.0 and later) |
| [Sweep parameter file](#sweep-param-file) | `spawn launch --param-file` | `defaults:`, `grid:` and `params:` rows, one instance per row | Passed to the workload as `PARAM_<key>`, unless it looks like a spawn setting |

If you are turning a `spawn launch` command line into a file, start with the
[flag table](#which-file-takes-which-flag) at the bottom: it shows where each
common flag can go, and which flags have no key in any file.

## `spawn launch --config` {#spawn-launch-config}

`spawn launch --config` reads **only** a `plugins:` list. Each entry takes `ref:`
and an optional `config:` map:

```yaml
# launch.yaml
plugins:
  - ref: tailscale
    config:
      tag: tag:spore
  - ref: rstudio-server
```

```sh
spawn launch analysis --instance-type r6i.4xlarge --ttl 8h --config launch.yaml
```

The instance type, TTL and every other setting stay on the command line. Since
spawn v0.137.0 the file is read strictly: any other key (a top-level
`instance_type:`, or a plugin entry written as `name:` instead of `ref:`) is an
error that names the line, and so is an entry with no `ref:`.

See [Plugins](/guides/plugins) for what a plugin is and how its `config:` is used.

## `lagotto --spawn-config` {#lagotto-spawn-config}

`lagotto watch --action spawn --spawn-config <file>` and
`lagotto launch --spawn-config <file>` read lagotto's own schema. It is **not**
the file `spawn launch --config` reads. The file can be a local path, an
`s3://bucket/key` URI, or `-` for stdin.

```yaml
# gpu-job.yaml
name: training
instance_type: p5.48xlarge
ttl: 6h
on_complete: terminate
command: ./run-training.sh && spored complete --status success
cost_limit: 400
volume_size: 200
iam_policy: [s3:ReadWrite]
tags:
  project: fieldwork
```

Keys may be written in snake_case, kebab-case or CamelCase (`on_complete`,
`on-complete` and `OnComplete` are the same key). Only top-level keys are read.

**Unknown keys.** From lagotto v0.65.0, a key that isn't in the table below is an
error when you create the watch or the scheduled launch. The error names the key
and the nearest accepted one, or, for `az`, `s3_read`, `s3_write`,
`instance_profile` and `completion_delay`, says where that setting lives instead.
lagotto v0.64.1 and earlier accepted such a key and then ignored it, so check an
older file against this table. A watch stored before the upgrade still fires.

**Files it references** (`user_data_file`, `user_data: "@path"`,
`iam_policy_file`) are read once, when you create the watch or the scheduled
launch, and stored inline with it. Whatever launches the instance later (the
hosted poller, or `lagotto poll`) uses that stored copy, so editing the files
afterwards doesn't change an existing watch.

**What the watch decides, not the file.** When a watch fires, lagotto replaces
`instance_type`, `region` and `spot` with what it matched, and picks the
availability zone. To choose the types, regions, zones or Spot, use the
`lagotto watch` arguments and flags (the type pattern, `--regions`, `--azs`,
`--spot`). For `lagotto launch`, the region is `--region` (or your AWS config's
region) and the zone is `--az`; `instance_type` and `spot` come from the file.

A file must set at least `instance_type` or `ami`, or lagotto rejects it as
probably mis-keyed.

### Keys

"If omitted" describes what the launched instance gets when the key isn't in the
file.

#### Core

| Key | Type | Meaning | If omitted | `spawn launch` flag |
|-----|------|---------|------------|---------------------|
| `name` | string | The instance's `Name` tag. For `lagotto launch`, also the key `--if-exists` matches on (`--name` overrides it). | Not set by lagotto | `--name` |
| `instance_type` | string | Instance type. Replaced by the matched type when a watch fires. | A watch uses the matched type; `lagotto launch` has no other source for it | `--instance-type` |
| `region` | string | Region. Always replaced: by the matched region (watch) or by `--region` / your AWS config's region (`lagotto launch`). | — | `--region` |
| `ami` | string | AMI ID. | Detected for the instance type (architecture and GPU) | `--ami` |
| `spot` | bool | Launch as Spot. Replaced by the match when a watch fires (set it with `lagotto watch --spot`). | `false` | `--spot` |

#### Lifecycle

| Key | Type | Meaning | If omitted | `spawn launch` flag |
|-----|------|---------|------------|---------------------|
| `ttl` | duration (`6h`, `90m`, `7d`) | Terminate the instance this long after launch. Must be greater than zero. | `24h`: every instance lagotto launches has a TTL | `--ttl` |
| `idle_timeout` | duration | Stop the instance after this much idleness. | Not set | `--idle-timeout` |
| `on_complete` | `terminate`, `stop` or `hibernate` | What spored does when the workload signals completion. | Not set | `--on-complete` |
| `completion_file` | path | The file spored watches for the completion signal. | `/tmp/SPAWN_COMPLETE` | `--completion-file` |
| `pre_stop` | string | Shell command run before any lifecycle stop or terminate (for example, syncing results to S3). | Not set | `--pre-stop` |
| `pre_stop_timeout` | duration | How long to wait for `pre_stop`. | spored's default | `--pre-stop-timeout` |
| `session_timeout` | duration | Log out idle shells after this long. | Not set | `--session-timeout` |
| `cost_limit` | number (USD) | Spend ceiling; spored terminates the instance when it's reached. | No limit | `--cost-limit` |

#### Workload

| Key | Type | Meaning | If omitted | `spawn launch` flag |
|-----|------|---------|------------|---------------------|
| `command` | string | Command spored runs once the instance is ready. | None | `--command` |
| `user_data` | string | Custom user-data script, inline, or `"@path"` to read a file. | None | `--user-data` |
| `user_data_file` | path or `s3://` URI | Custom user-data script read from a file. Wins over `user_data` if both are set. | None | `--user-data-file` |

#### IAM

When none of these four is set, the instance gets spawn's default spored
instance profile.

| Key | Type | Meaning | If omitted | `spawn launch` flag |
|-----|------|---------|------------|---------------------|
| `iam_policy` | string or list | Service-level policy shorthands, for example `s3:ReadWrite` or `[s3:ReadOnly, dynamodb:WriteOnly]`. A comma-separated string also works. | None | `--iam-policy` |
| `iam_role` | string | IAM role name for the instance. Authorize it for the hosted poller with `lagotto setup --instance-role <name>`. | None | `--iam-role` |
| `iam_policy_file` | path or `s3://` URI | A custom policy JSON document. Read when the watch is created and stored as `iam_policy_document`. | None | `--iam-policy-file` |
| `iam_policy_document` | string (JSON) | The same custom policy, inline. | None | No flag (the inline form of `--iam-policy-file`) |

#### Storage

| Key | Type | Meaning | If omitted | `spawn launch` flag |
|-----|------|---------|------------|---------------------|
| `volume_size` | integer (GiB) | Root EBS volume size. | The AMI's root volume size | `--volume-size` |
| `efs_id` | string | EFS filesystem to mount (`fs-…`). | None | `--efs-id` |
| `fsx_id` | string | Existing FSx for Lustre filesystem to mount. | None | `--fsx-id` |
| `fsx_create` | bool | Create an FSx for Lustre filesystem for this instance. Needs `fsx_lifecycle`. | `false` | `--fsx-create` |
| `fsx_lifecycle` | string | Must be `ephemeral` here: the filesystem is reclaimed once the instance is gone. For a durable filesystem, create it separately and use `fsx_id`. | Required with `fsx_create` | `--fsx-lifecycle` |
| `fsx_s3_bucket` | string | S3 bucket the created filesystem imports from and exports to. | None | `--fsx-s3-bucket` |
| `fsx_import_path` | `s3://` URI | Import path. | None | `--fsx-import-path` |
| `fsx_export_path` | `s3://` URI | Export path. | `s3://<fsx_s3_bucket>/` | `--fsx-export-path` |
| `fsx_mount_point` | path | Where the filesystem is mounted. | `/fsx` | `--fsx-mount-point` |
| `fsx_storage_capacity` | integer (GB) | Size of the created filesystem. | `1200` | `--fsx-storage-capacity` |

#### Capacity and pricing

| Key | Type | Meaning | If omitted | `spawn launch` flag |
|-----|------|---------|------------|---------------------|
| `reservation_id` | string | Capacity Reservation or Capacity Block to launch into (`cr-…`). This is what targets the launch: `lagotto launch --reservation-id` only times the launch to the reservation. | None | `--reservation-id` |
| `capacity_block` | bool | `reservation_id` is a Capacity Block for ML. Can't be combined with Spot. | `false` | `--capacity-block` |
| `spot_max_price` | string or number (USD/hour) | Maximum Spot price. | No cap | `--spot-max-price` |

#### Other

| Key | Type | Meaning | If omitted | `spawn launch` flag |
|-----|------|---------|------------|---------------------|
| `key_name` | string | EC2 key pair name. | None | `--key-name` |
| `tags` | map, or list of `key=value` strings | Extra tags on the instance and its volumes. On a watch launch, lagotto adds its own `lagotto:watch-id` tag (and `lagotto:project`, if the watch has one). | None | `--tag` (repeatable) |

## `spawn launch --param-file` {#sweep-param-file}

A [parameter sweep](/guides/parameter-sweeps) file has three top-level keys:
`defaults:` (applied to every row), `grid:` (lists expanded into every
combination) and `params:` (one instance per row). A row's own key always wins.
`spawn launch` flags passed next to `--param-file` apply to every row; for
`--ttl`, `--idle-timeout`, `--cost-limit` and `--volume-size`, the flag also beats
the same key in `defaults:`.

```yaml
defaults:
  instance_type: g5.xlarge
  ttl: 4h
  on_complete: terminate
  command: "python train.py --lr $PARAM_learning_rate"
params:
  - learning_rate: 0.001
  - learning_rate: 0.01
    instance_type: g5.2xlarge
```

Inside `defaults:` and each row, these keys are spawn settings:

| Key | Meaning | `spawn launch` flag |
|-----|---------|---------------------|
| `instance_type` | Instance type | `--instance-type` |
| `region` | Region | `--region` |
| `az`, `availability_zone` | Availability zone | `--az` |
| `ami` | AMI ID | `--ami` |
| `key_pair`, `key_name` | EC2 key pair name | `--key-name` |
| `spot` | Launch as Spot (`true`/`false`) | `--spot` |
| `spot_max_price` | Maximum Spot price (a string) | `--spot-max-price` |
| `hibernate` | Enable hibernation | `--hibernate` |
| `ttl` | Terminate after this duration | `--ttl` |
| `idle_timeout` | Stop after this much idleness | `--idle-timeout` |
| `hibernate_on_idle` | Hibernate instead of stop when idle | `--on-idle hibernate` |
| `cost_limit` | Spend ceiling in USD | `--cost-limit` |
| `session_timeout` | Log out idle shells | `--session-timeout` |
| `on_complete` | Action on completion | `--on-complete` |
| `completion_file` | Completion signal file | `--completion-file` |
| `completion_delay` | Grace period after the completion signal | `--completion-delay` |
| `dns`, `dns_name` | DNS label | `--dns` |
| `step` | Workflow step name (the `spawn:step` tag) | None |
| `command`, `user_command` | The row's command | `--command` |
| `user_data` | The row's own script, run after the bootstrap and after `--user-data` | `--user-data` |
| `iam_role` | An existing instance profile, by name | `--instance-profile` |
| `name` | Instance name | `--name` |
| `volume_size` | Root EBS volume size in GiB | `--volume-size` |

Any other key is a **workload parameter**: it reaches the instance as a
`PARAM_<key>` environment variable. Because of that, spawn can't tell a
misspelled setting from your own parameter, so it rejects keys that look like
settings:

- a spawn key with hyphens or capitals (`on-complete`, `TTL`);
- a key that names a CLI-only flag, or a setting people expect but that doesn't
  exist (`ttl_hours`, `max_cost`, `budget`, `instance_profile`,
  `max_concurrent` and others), with a message saying what to use instead;
- a key that can't be an environment variable name.

To pass one of the rejected names to your workload anyway, prefix it:
`param:budget: 50` becomes `PARAM_budget`. A spawn key written at the top level,
outside `defaults:`, `grid:` and `params:`, is an error too, since it would be
ignored.

## Which file takes which flag {#which-file-takes-which-flag}

Common `spawn launch` flags and where each can be written. "—" means there is no
key for it in that file. `spawn launch --config` takes none of these: it holds
only `plugins:` (the `--plugin` flag's file form).

| `spawn launch` flag | lagotto `--spawn-config` | Sweep `--param-file` row |
|---------------------|--------------------------|--------------------------|
| `--instance-type` | `instance_type` (a watch uses the matched type) | `instance_type` |
| `--region` | — (`lagotto watch --regions`, `lagotto launch --region`) | `region` |
| `--az` | — (`lagotto watch --azs`, `lagotto launch --az`) | `az` |
| `--spot` | `spot` (a watch uses `lagotto watch --spot`) | `spot` |
| `--spot-max-price` | `spot_max_price` | `spot_max_price` |
| `--ami` | `ami` | `ami` |
| `--ttl` | `ttl` | `ttl` |
| `--idle-timeout` | `idle_timeout` | `idle_timeout` |
| `--on-complete` | `on_complete` | `on_complete` |
| `--completion-file` | `completion_file` | `completion_file` |
| `--completion-delay` | — | `completion_delay` |
| `--pre-stop` | `pre_stop` | — (flag applies to every row) |
| `--cost-limit` | `cost_limit` | `cost_limit` |
| `--command` | `command` | `command` |
| `--user-data` / `--user-data-file` | `user_data` / `user_data_file` | `user_data` (runs in addition to the flag's script) |
| `--tag` | `tags` | — (flag applies to every row) |
| `--volume-size` | `volume_size` | `volume_size` |
| `--name` | `name` | `name` |
| `--key-name` | `key_name` | `key_name` |
| `--iam-role` | `iam_role` | — (flag) |
| `--iam-policy` | `iam_policy` | — (flag) |
| `--iam-policy-file` | `iam_policy_file` | — (flag) |
| `--instance-profile` | — (use `iam_role`) | `iam_role` |
| `--s3-read` / `--s3-write` | — (use `iam_policy: s3:ReadOnly` / `s3:ReadWrite`, or `iam_policy_document`) | — (flag) |
| `--efs-id` | `efs_id` | — (flag) |
| `--fsx-id` | `fsx_id` | — (flag) |
| `--fsx-create` and the other `--fsx-*` flags | `fsx_create`, `fsx_lifecycle`, … | — (a sweep can't create a filesystem: create it first and pass `--fsx-id`) |
| `--reservation-id` | `reservation_id` | — (flag) |
| `--capacity-block` | `capacity_block` | — (flag) |
| `--session-timeout` | `session_timeout` | `session_timeout` |
| `--plugin` | — | — (flag); `spawn launch --config` holds the file form |

On a sweep, a flag marked "flag" is passed on the command line next to
`--param-file` and applies to every row. spawn refuses, before launching anything,
the few flags a sweep can't honour.
