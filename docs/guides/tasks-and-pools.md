---
description: "Run one command from a TaskSpec with spawn task run (inputs staged from S3, outputs staged back, a durable completion record), or many short tasks through a reusable worker pool with spawn pool."
---

# Tasks and worker pools: `spawn task run` and `spawn pool`

A **task** is one command, described in a JSON file called a **TaskSpec**. spawn
picks an instance for it, copies the inputs in from S3, runs the command, copies
the outputs back, and writes a **completion record** to S3. The instance then
terminates itself. The record stays in S3 after the instance is gone, so you
(or a workflow engine) can read the result later.

A **worker pool** runs many tasks through a few reusable instances, so they
don't each pay for an instance boot. It takes the same TaskSpec files.

This guide is for researchers scripting runs and for people writing a
[workflow adapter](/guides/workflow-engines): all six adapters run their tasks
through `spawn task run`. To choose between tasks, pools and spawn's other ways
of running work, see [Which execution tool?](/guides/choosing-execution).

## Run one task

Save this as `hello.json`:

```json
{
  "task_id": "hello-001",
  "command": ["echo", "hello from spawn"],
  "resources": { "cpu": 2 },
  "lifecycle": { "ttl": "30m" }
}
```

Preview it, then run it:

```sh
spawn task run --spec hello.json --dry-run
spawn task run --spec hello.json --wait
```

`--dry-run` launches nothing. It shows the instance type spawn would choose and
its hourly rate, the AMI, the root disk, the purchase type, the TTL and the
action on completion. It also shows the **maximum cost**, which is the on-demand
rate times the TTL. Sizing looks up instance types and prices, so a dry run
still needs AWS credentials.

Without `--wait`, `spawn task run` returns as soon as the instance is launched
and prints where the completion record will appear and how to poll it.

### What happens on the instance

1. Each `inputs[]` entry is copied from S3 to its local path with `aws s3 cp`.
2. The command runs on the host, or inside `container` if the spec sets one.
3. Each `outputs[]` entry is copied from its local path to S3. This happens even
   if the command failed, but not if staging the inputs failed.
4. The command log is uploaded, then `completion.json` and `.exitcode` are
   written next to it.
5. The instance acts on `lifecycle.on_complete`. The default is `terminate`.

If a lifecycle limit ends the instance while the command is still running (its
TTL, its cost limit, an idle stop or a Spot interruption), spawn still uploads
the command log and writes a completion record before the instance stops. So
does `spawn terminate`: on a running task instance it first runs the same flush
over SSM, so `command.log` and a `failed` record with `terminal_reason`
`user_terminated` reach S3. That flush is bounded and best-effort; if it fails,
the instance is terminated anyway. See [Completion records](#completion-records).

### `spawn task run` flags

| Flag | Default | What it does |
|---|---|---|
| `--spec` | (required) | Path to the TaskSpec JSON file |
| `--dry-run` | off | Size and preview without launching |
| `--wait` | off | Wait for the completion record, then exit with the task's exit code, or `1` if its `state` isn't `completed`. See [Exit codes](#exit-codes) |
| `--poll-interval` | `15s` | How often `--wait` checks for the record |
| `--region` | the configured region | Region to size and launch in |
| `--ami` | auto-selected | Use this AMI. Overrides `placement.ami` |

## The TaskSpec

### Parsing rules

- **Unknown fields are an error.** A misspelt field such as `"cpus"` fails with
  `json: unknown field "cpus"` instead of being ignored. Parsing stops at the
  first unknown field, so fix them one at a time.
- Once the JSON parses, every other problem is reported together, one per line,
  under `invalid task spec:`.
- Validation runs locally and doesn't contact AWS. A bad spec fails before any
  AWS call.

### Top-level fields

| Field | Required | Default | Rules |
|---|---|---|---|
| `task_id` | yes | | Non-empty. Names the instance and the folder the completion record goes in |
| `command` | yes | | An argv array, not a shell string. Each element is passed as-is, with no shell parsing. Use `["bash", "-c", "..."]` if you need a shell |
| `container` | no | run on the host | An image reference. See [Containers](#containers) |
| `resources` | no | | See [`resources`](#resources) |
| `inputs` | no | | List of `{ "source", "destination" }`. `source` must start with `s3://` |
| `outputs` | no | | List of `{ "source", "destination" }`. `destination` must start with `s3://` |
| `placement` | no | | See [`placement`](#placement) |
| `lifecycle` | yes | | `lifecycle.ttl` is required. See [`lifecycle`](#lifecycle) |
| `env` | no | | Map of variable name to value. Names must match `[A-Za-z_][A-Za-z0-9_]*`. Values can be anything. Reaches host and container commands; see [Containers](#containers) |
| `results_prefix` | no | `s3://spawn-results-<account>-<region>/tasks` | Where the completion record, `.exitcode` and `command.log` go. See [Completion records](#completion-records) |
| `regenerable` | no | `false` | Opts the outputs in to future deletion. See [Keeping results](/guides/results-retention#opting-in-to-future-deletion) |

### `resources`

| Field | Default | Rules and meaning |
|---|---|---|
| `cpu` | `0` (no minimum) | Minimum vCPUs. Must not be negative |
| `memory_gib` | `0` (no minimum) | Minimum memory in GiB. Must not be negative. A container task is sized to at least 2 GiB whatever this says; see [Containers](#containers) |
| `memory_headroom_percent` | `0` | 0–100. Sizes against `memory_gib` plus this percentage: 32 GiB with 20 is sized as 38.4 GiB |
| `gpus` | `0` | Minimum GPUs. Must not be negative |
| `architecture` | any | `x86_64` or `arm64` |
| `families` | any | Allow-list of family prefixes, such as `["c8g", "m8g"]` |
| `instance_type` | | Use exactly this type. `cpu`, `memory_gib`, `architecture` and `families` are then ignored |
| `disk_gib` | the AMI's default | Size of the root EBS volume in GiB |
| `purchase` | `on_demand` | `on_demand` or `spot` |
| `fallback` | | `on_demand`: if a Spot launch fails for lack of capacity, retry once on-demand in the same region. The retry has the same `placement` mounts as the Spot attempt (before spawn v0.135.2 it came up without them) |
| `s3_read_write` | | `s3://` URIs of buckets the command itself reads and writes (for tools that do their own S3 I/O). Grants list, get, put and delete on the **whole bucket**; any prefix is ignored |

### `inputs` and `outputs`

- `source` and `destination` are both required.
- A `source` ending in `/` is a directory and is copied recursively.
- Inputs only come **from** S3 and outputs only go **to** S3. Files on a mounted
  EFS, FSx or EBS volume from `placement` are already on the instance, so they
  don't need an entry.
- Any absolute local path works. spawn creates each input destination's
  directory and each output source's directory before staging, owned by the
  user the command runs as.
- Inputs are staged on the instance's disks. `/tmp` on Amazon Linux 2023 is held
  in memory and capped near half the instance's RAM, so a large input belongs
  under a path such as `/work`, with `resources.disk_gib` set to fit it.

### `placement`

| Field | Meaning |
|---|---|
| `ami` | AMI ID. Overridden by `--ami` |
| `availability_zone` | Launch in this zone |
| `volumes` | List of `{ "snapshot": "snap-…", "mount_path": "…", "read_only": true }`. Each creates an EBS volume from the snapshot and mounts it. `read_only` defaults to `false` |
| `efs_id` | An existing EFS file system to mount |
| `efs_mount_point` | Where to mount it. Default `/efs` |
| `fsx_lustre_id` | An existing FSx for Lustre file system to mount |
| `fsx_mount_point` | Where to mount it. Default `/fsx` |

These are mounted before the command runs, and are also mounted into the
container when there is one.

### `lifecycle`

| Field | Default | Meaning |
|---|---|---|
| `ttl` | (required) | The hard deadline, such as `90m`, `4h`, `1d` or `2d12h`. The instance terminates at the TTL whatever it is doing |
| `on_complete` | `terminate` | `terminate`, `stop` or `hibernate`, when the task finishes |
| `cost_limit` | `0` (off) | End the instance when its spend reaches this many US dollars. Must not be negative |

### A fuller example

This runs a Python script in a container on a Graviton instance, as Spot with an
on-demand fallback, and stages a directory of outputs back. Change the bucket
names to your own.

```json
{
  "task_id": "featurize-shard-007",
  "container": "docker.io/library/python:3.12-slim",
  "command": ["python3", "/work/code/featurize.py", "/work/in/shard-007.csv", "/work/out/"],
  "resources": {
    "cpu": 4,
    "memory_gib": 16,
    "memory_headroom_percent": 10,
    "architecture": "arm64",
    "families": ["c8g", "m8g"],
    "disk_gib": 50,
    "purchase": "spot",
    "fallback": "on_demand"
  },
  "inputs": [
    { "source": "s3://my-lab-data/code/featurize.py", "destination": "/work/code/featurize.py" },
    { "source": "s3://my-lab-data/shards/shard-007.csv", "destination": "/work/in/shard-007.csv" }
  ],
  "outputs": [
    { "source": "/work/out/", "destination": "s3://my-lab-results/featurize/shard-007/" }
  ],
  "lifecycle": { "ttl": "2h", "on_complete": "terminate", "cost_limit": 5 },
  "regenerable": true
}
```

spawn gives the instance an IAM role scoped to this spec: read access to the
input buckets, write access to the output buckets and the results bucket, and
full access to any `s3_read_write` buckets. A private ECR image also gets
read-only ECR access so it can be pulled.

## How sizing works

Unless you set `resources.instance_type`, spawn searches the region for instance
types that meet `cpu`, `memory_gib` (plus headroom), `architecture` and `gpus`,
keeps only the `families` you allowed, and picks the **cheapest by on-demand
price**. When prices are equal, it picks the **smallest** that fits. This
matters for families such as hpc7g, where every size costs the same: a 16-vCPU
request gets `hpc7g.4xlarge`, not `hpc7g.16xlarge`.

Spot specs are sized by on-demand price too. A type whose price can't be found
is only chosen if nothing priced fits.

- **To steer**, use `families`. Cheapest-that-fits can land on an older, slower
  generation. The dry run flags Graviton 1 (`a1`) when it does.
- **To pin**, use `instance_type`. That's also how to run deliberately different
  sizes of one family, which `cpu` and `memory_gib` can't tell apart.

```json
{
  "task_id": "bench-hpc7g-4xl",
  "command": ["/bin/true"],
  "resources": { "instance_type": "hpc7g.4xlarge" },
  "lifecycle": { "ttl": "1h" }
}
```

spawn chooses the AMI from the instance type: GPU families (g5, g6, p4, p5 and
others) get the Amazon Linux 2023 NVIDIA deep learning AMI, and everything else
gets standard Amazon Linux 2023 for the type's architecture. An AMI from
`--ami` or `placement.ami` always wins.

## Containers

With `container` set, spawn installs Docker if the AMI lacks it, logs in to ECR
for a private ECR image, pulls the image and runs `command` as the container's
arguments. On a GPU instance, or with `resources.gpus` set, it also installs the
NVIDIA Container Toolkit and passes `--gpus all`.

Staging still happens on the host, so the image doesn't need the AWS CLI. The
directories of your inputs and outputs, and any `placement` mount points, are
bind-mounted into the container at the same paths. The container runs as the
instance user's uid and gid, not the image's `USER`, so it can write to those
directories whatever the image declares.

A container task is sized to at least **2 GiB** of memory, even when
`resources.memory_gib` is lower or unset, because installing Docker on a smaller
instance gets OOM-killed. The dry run says when this floor raised the request. A
pinned `resources.instance_type` is used as given, with a warning when it has
less than 2 GiB. If Docker can't be installed or its daemon doesn't start, the
command isn't run and the record says `retry_class` `instance_health`, which is
worth retrying (see [Completion records](#completion-records)).

`env` reaches the container: each key is passed to `docker run` as
`-e KEY=VALUE`. The values are on the `docker run` command line, so anyone who
can list processes on the instance can see them while the task runs. Don't put
secrets in `env`. Before spawn v0.135.2, `env` was set only in the host shell and
a container never saw it.

```json
{
  "task_id": "count-lines-007",
  "container": "docker.io/library/python:3.12-slim",
  "command": ["bash", "-c", "wc -l /work/in/shard.csv > /work/out/count-$SHARD.txt"],
  "env": { "SHARD": "007" },
  "resources": { "cpu": 2, "memory_gib": 4 },
  "inputs": [
    { "source": "s3://my-lab-data/shards/shard-007.csv", "destination": "/work/in/shard.csv" }
  ],
  "outputs": [
    { "source": "/work/out/", "destination": "s3://my-lab-results/counts/" }
  ],
  "lifecycle": { "ttl": "1h" }
}
```

## Completion records

Each task writes three objects under its results prefix:

```
s3://spawn-results-<account>-<region>/tasks/<task_id>/completion.json
s3://spawn-results-<account>-<region>/tasks/<task_id>/.exitcode
s3://spawn-results-<account>-<region>/tasks/<task_id>/command.log
```

If the spec sets `results_prefix`, they go under `<results_prefix>/<task_id>/`
instead. spawn creates its own `spawn-results-…` bucket if needed, but not a
bucket you name: that one must already exist, so a typo fails instead of
creating a stray bucket.

`completion.json` has these fields:

| Field | Meaning |
|---|---|
| `task_id` | The spec's `task_id` |
| `run_id` | Identifies this attempt. A new one is made at every launch |
| `exit_code` | The command's exit status. `-1` if the instance ended before the command returned |
| `state` | `completed` or `failed` |
| `started_at`, `ended_at` | UTC timestamps, such as `2026-10-18T14:03:12Z` |
| `cost_estimate` | What the run cost in USD. Present only when the instance's hourly rate was known |
| `logs` | `s3://` URI of `command.log`, when it uploaded |
| `retry_class` | Why it failed, if it did. See below |
| `terminal_reason` | Set only when the instance was ended mid-command: `ttl_expired`, `cost_limit_exceeded`, `idle_timeout` or `spot_interruption` by a lifecycle limit, or `user_terminated` by `spawn terminate` |

`retry_class` tells an adapter whether running the task again is likely to help:

| `retry_class` | Written when | Worth retrying |
|---|---|---|
| (empty) | The task succeeded, or ended for a reason with no class | no |
| `staging_error` | An input failed to copy or a staging directory couldn't be created. The command didn't run | no |
| `app_error` | The command exited non-zero | no |
| `output_delivery_error` | The command succeeded, but an output failed to upload | yes |
| `instance_health` | A container task's Docker install failed or its daemon didn't start. The command didn't run | yes |
| `ttl_expired` | The TTL ended the instance mid-command | no |
| `spot_interruption` | Spot reclaimed the instance mid-command | yes |

`command.log` contains timestamped `spawn:` lines marking each phase (stage-in,
Docker install, image pull, command, stage-out), so you can see where the time
went.

`outputs[]` uploads are tagged with what the run cost to produce; that's covered
in [Keeping results](/guides/results-retention).

### Waiting, polling and JSON

```sh
spawn task run --spec featurize.json --wait -o json
```

With `--wait`, spawn polls until the record for **this** attempt appears, then
prints it. With `-o json` it prints the record as JSON on stdout, and any notices
go to stderr. Waiting gives up two minutes after the TTL.

Without `--wait`, `-o json` prints the launch result instead:

```json
{"task_id":"hello-001","instance_id":"i-0123456789abcdef0","region":"us-east-1","az":"us-east-1b","instance_type":"t4g.small","spot":false}
```

Then poll with `spawn task status`:

```sh
spawn task status hello-001
spawn task status hello-001 -o json
spawn task status hello-001 --check-complete
```

Until the record exists, `spawn task status` asks EC2 about the task's
instance instead of assuming it's running:

| What EC2 says | `task status` prints | `--check-complete` exits |
|---|---|---|
| An instance for the task is pending, running, stopping or stopped | `Task hello-001: running (no completion record yet; instance i-… is running)` | `2` |
| Its instances are all terminated or shutting down | `Task hello-001: terminated (no completion record)`, with EC2's reason. The instance ended without a terminal flush, so `command.log` may not have been saved | `1` |
| No instance for it in the region, or the lookup failed | `Task hello-001: unknown (…)` | `3` |

Before spawn v0.136.0, a task killed without a flush read `running` forever.
Without `--check-complete`, `unknown` is an error (exit 1). If the spec set
`results_prefix`, pass the same value with `--results-prefix`, because
`task status` sees only the task ID. Use `--region` for a task in another region.

### Exit codes

| Command | Exit code |
|---|---|
| `spawn task run --wait` | The record's `exit_code` when it's non-zero (a value of `-1` shows up as `255`). Otherwise `0` if `state` is `completed` and `1` if it isn't |
| `spawn task run` without `--wait` | `0` once the instance is launched |
| `spawn task status --check-complete` | `0` completed, `1` failed (including terminated with no record), `2` running, `3` error (including no record and no instance) |
| Any error in spawn itself (bad spec, AWS error, `--wait` timeout) | `1` |

An `output_delivery_error` record has `exit_code` 0 and `state` `failed`,
because the command itself succeeded. `--wait` exits 1 for it (since spawn
v0.135.2; before that it exited 0). A spawn error also exits 1, so to tell the
two apart in a script, read the record with `-o json`.

### Running a `task_id` again

Running the same spec again is safe. At launch, spawn deletes the previous
attempt's `completion.json` and `.exitcode`, and `--wait` ignores any record
whose `run_id` isn't the one it just launched. A record from an old spawn
version with no `run_id` is accepted with a warning.

`spawn task status` has no attempt to compare against, so it shows whatever
record is there.

## Many short tasks: `spawn pool`

When each task takes seconds to minutes, starting an instance per task costs
more than the work, and tasks finish faster than new instances can launch. A
pool starts N workers once. They pull tasks from an SQS queue made for the run
and keep running until the queue stays empty, then terminate.

Use a pool for hundreds or thousands of short tasks that fit one instance type.
Use `spawn task run` when tasks are long, need different sizes, or need
`placement`.

### The lifecycle

```sh
spawn pool create --run-id cohort-a --workers 20 --instance-type c7i.large --s3-read my-lab-data --s3-write my-lab-results
for f in specs/*.json; do spawn pool submit --run-id cohort-a --spec "$f"; done
spawn pool status --run-id cohort-a
spawn task status count-lines-007 --check-complete
spawn pool drain --run-id cohort-a
```

1. **`create`** makes the queue `spawn-pool-<run-id>` and an IAM role for this
   pool's workers, then launches the workers.
   It waits until at least `--min-viable` workers are up. If it can't get that
   many, it deletes the queue and reports why each worker failed. Ask for N and
   get fewer, and the tasks still drain through the workers you got.
2. **`submit`** validates a TaskSpec, uploads it to the results bucket, and adds
   it to the queue. It launches nothing, so it's fast.
3. **`status`** prints `pool cohort-a: 12 waiting, 20 in-flight`. Both counts
   are SQS approximations.
4. Each task writes the **same completion record** as `spawn task run`, so poll
   with `spawn task status <task-id>`.
5. **`drain`** deletes the queue, waits for the workers to terminate, then
   deletes the pool's IAM role. Run it once every record you need is in.

`--run-id` is shared by all four commands. It becomes part of an SQS queue name,
so use letters, digits, `-` and `_`.

### `spawn pool create` flags

| Flag | Default | What it does |
|---|---|---|
| `--run-id` | (required) | Names the pool and its queue |
| `--workers` | (required) | How many workers to launch. At least 1 |
| `--instance-type` | (required) | Every worker's type. Pools don't size |
| `--min-viable` | `1` | Fewest workers that count as success |
| `--spot` | off | Launch the workers as Spot |
| `--ttl` | `4h` | Each worker's TTL. It terminates at this age, busy or not |
| `--idle-timeout` | `5m` | How long a worker waits on an empty queue before it terminates |
| `--cost-limit` | `0` (off) | Spend ceiling in US dollars **per worker**, compute and storage. spored terminates a worker that reaches it, as with `spawn launch --cost-limit` |
| `--container` | | An image the pool's tasks run. Repeatable. A private ECR image gets the workers' role an ECR pull grant |
| `--visibility-timeout` | `900` | Seconds a claimed task is hidden from other workers. Must be longer than your longest task |
| `--s3-read` | | Bucket your tasks read inputs from. Repeatable |
| `--s3-write` | | Bucket your tasks write outputs to. Repeatable |

### What a pooled task uses from its spec

The worker already exists, so a pooled task uses less of its spec:

| Spec field | In a pool |
|---|---|
| `task_id`, `command`, `inputs`, `outputs`, `results_prefix` | Used as in `spawn task run` |
| `container` | Used. A **private ECR** image can be pulled only if you named it with `--container` at `create`; otherwise the workers' role has no ECR permission |
| `env` | Used, for host and container commands, as in `task run` |
| `resources.gpus` | Above 0, the container gets `--gpus all`. Otherwise ignored |
| Every other `resources` field, `placement`, `lifecycle` | Ignored. The pool's flags decide the instance and its lifetime. `lifecycle.ttl` is still required to pass validation |

Workers can only reach the buckets you name at `create`. Every bucket in your
`inputs`, `outputs` and `results_prefix` needs an `--s3-read` or `--s3-write`.
Tasks in a pool run one after another on each worker, each in its own empty
directory that is deleted afterwards.

A task that runs longer than `--visibility-timeout` becomes visible again and
another worker runs it a second time. A task that is never claimed is deleted
from the queue after 12 hours.

### How workers end, and what a pool costs

You pay for every worker from boot until it stops or terminates, whether or not
it has a task. The minimum cost of a pool is N workers × the hourly rate × (time
to work through the queue + `--idle-timeout`).

- When a worker's queue has been empty for `--idle-timeout`, the worker process
  exits and spored **terminates** the instance. Before spawn
  v0.136.0 it was stopped instead, and kept billing for its EBS volume until its
  TTL.
- A worker whose every claim fails for `--idle-timeout` terminates the same way.
- A worker process that keeps crashing is restarted up to 20 times, then gives
  up, and the instance terminates.
- The TTL (`--ttl`) terminates a worker that is still running, busy or not, and
  `--cost-limit` terminates one that has spent its limit.
- `drain` deletes the queue, and each worker terminates at its next poll.

A worker that dies mid-task doesn't remove the task from the queue, so another
worker picks it up after the visibility timeout. A task that ran and failed is
removed. Its completion record says why, and resubmitting it is up to you.

Outputs a pooled task uploads are tagged with what the run cost to produce, as
`spawn task run` outputs are ([Keeping results](/guides/results-retention)). The
workers' role can tag objects in the results bucket and in every `--s3-write`
bucket. Before spawn v0.136.0, pooled outputs were uploaded untagged.

### Each pool's IAM role, and `drain`

Each pool gets its own worker role and instance profile, named
`spawn-pool-worker-<hash of the run id>` and tagged `spawn:pool-run-id`, so
several pools can run in one account at once. (Before spawn v0.136.0 every pool
shared one role, `spawn-pool-worker`, and a second `spawn pool create` cut the
first pool's workers off from their queue. That role is no longer used, so
you can delete it; `spawn orphans` reports it when no spawn instances are left.)

A worker whose role is deleted loses its credentials, and then spored can't
terminate it. So `spawn pool drain` deletes the role only once no worker of the
pool is pending, running, stopping or stopped. It checks again for up to
`--wait` (default `2m`; `0` checks once). If workers are still there after that,
drain keeps the role and says so; run `spawn pool drain` again later to remove
it.

`drain` is safe to repeat. When the queue is already gone it prints
`Pool <run-id> already drained (no queue found)`, still removes the role if no
workers remain, and exits 0.

## Other `task` subcommands

`spawn task diagnose <name|instance-id>` summarizes one instance (state, age,
TTL, an estimated cost, a likely cause for a stop or termination) and where its
logs are. It works on any spawn instance, not only tasks, and reads only
instance data and tags, so it works when you can't connect. `-o json` prints it
as JSON.

## See also

- [Which execution tool?](/guides/choosing-execution): tasks and pools next to sweeps, arrays, queues and pipelines
- [Workflow engines](/guides/workflow-engines): the adapters that generate TaskSpecs for you
- [Keeping results](/guides/results-retention): what task outputs are tagged with, and tiering
- [Costs & safety guarantees](/safety): TTL, idle and cost limits
- Command reference: [`spawn task run`](/tools/reference/spawn#spawn-task-run), [`spawn pool`](/tools/reference/spawn#spawn-pool)
