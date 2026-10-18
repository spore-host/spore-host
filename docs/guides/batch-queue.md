---
description: "An instance queue runs a sequence of dependent jobs on a single instance, one at a time in dependency order. Launched with --batch-queue."
---

# Instance queues

An **instance queue** runs several dependent jobs **on one instance, one at a time,
in dependency order**. Unlike [pipelines](/guides/pipelines), which chain stages
across *separate* instances, an instance queue keeps everything on the same
machine — ideal when the steps share large local data, packages, model weights, or
cached indexes and you don't want to pay to boot (and re-stage) a machine per step.

::: tip Name vs. flag
This feature is launched with the `--batch-queue` flag and its config uses
`queue_name` — we call the *concept* an "instance queue" because everything runs on
one already-selected instance, not on a pool of workers waiting for jobs (which is
what "batch queue" usually implies elsewhere). The flag name is unchanged.
:::

## Sequential, not parallel

Jobs run **strictly one at a time**, in a topological order derived from
`depends_on`. `depends_on` therefore controls *ordering* (and validates there are
no cycles); it does **not** enable concurrency — two jobs never run at the same
time on the instance, even if their dependencies would allow it. If you need stages
to run concurrently on different machines, use a [pipeline](/guides/pipelines).

## When to use an instance queue

- Jobs that share large local datasets (avoid re-staging between instances)
- Sequential steps where each step depends on the previous one's output
- Workflows where spinning up a new instance per step is too slow or costly

For stages that can run in parallel or need different instance types per step, use [pipelines](/guides/pipelines) or [parameter sweeps](/guides/parameter-sweeps) instead. Not sure? See [Which execution tool?](/guides/choosing-execution).

## Queue file format

Create a JSON file describing your jobs:

```json
{
  "queue_id": "my-pipeline-001",
  "queue_name": "my-pipeline",
  "jobs": [
    {
      "job_id": "preprocess",
      "command": "python preprocess.py --input /data/raw --output /data/clean",
      "timeout": "30m"
    },
    {
      "job_id": "train",
      "command": "python train.py --data /data/clean --output /models/",
      "timeout": "4h",
      "depends_on": ["preprocess"]
    },
    {
      "job_id": "evaluate",
      "command": "python eval.py --model /models/best.pt",
      "timeout": "30m",
      "depends_on": ["train"]
    }
  ],
  "global_timeout": "6h",
  "on_failure": "stop"
}
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `queue_id` | yes | Identifier for the queue. A queue file without it fails validation |
| `queue_name` | no | Human-readable name |
| `jobs` | yes | Array of job definitions |
| `job_id` | yes | Unique identifier for this job |
| `command` | yes | Shell command to run |
| `timeout` | yes | Per-job timeout (e.g. `30m`, `4h`) |
| `depends_on` | no | List of `job_id`s that must complete first (ordering only) |
| `env` | no | Per-job environment variables (map) |
| `retry` | no | Per-job retry policy (see below) |
| `result_paths` | no | Files/globs to upload to S3 after the job succeeds |
| `global_timeout` | no | Total timeout for the entire queue |
| `on_failure` | no | `stop` (default) or `continue` on job failure |
| `result_s3_bucket` / `result_s3_prefix` | no | Where per-job outputs and logs are uploaded |

**Per-job `retry`:**

```json
"retry": {
  "max_attempts": 3,
  "backoff": "exponential",
  "base_delay": "2s",
  "max_delay": "5m",
  "retry_on_codes": [1, 137],
  "dont_retry_on_codes": [2]
}
```

`max_attempts` (at least 1) and `backoff` are required in a `retry` block.
`backoff` must be `fixed` or `exponential`. `exponential-jitter` is defined but
validation rejects it today; that's tracked in
[spawn#1119](https://github.com/spore-host/spawn/issues/1119). Use
`retry_on_codes` to retry only specific exit codes, or `dont_retry_on_codes` to
never retry certain ones.

## Launch

```sh
spawn launch my-job \
  --instance-type g5.xlarge \
  --batch-queue pipeline.json \
  --ttl 8h
```

spawn uploads the queue config to S3, launches the instance, and the spored daemon picks up and runs the jobs one at a time in dependency order.

## Monitoring, logs, and recovery

Each job's stdout and stderr are captured **per job** on the instance and uploaded
to S3 alongside the queue's results:

```sh
spawn status my-job                                    # instance state
spawn queue status <instance-id>                       # per-job queue state (over SSH)
spawn logs my-job --which spored                       # the spored log, where the queue runner logs
spawn connect my-job -- tail -f /var/log/spored.log    # follow the daemon log live

# On the instance, per-job logs live at:
#   /var/log/spored/jobs/<job_id>-stdout.log
#   /var/log/spored/jobs/<job_id>-stderr.log
# and (with result_s3_prefix set) upload to <prefix>/jobs/<job_id>/stdout.log
```

Download a queue's outputs, logs and final state from S3 with `spawn queue
results`. Pass the queue config with `--config` so it reads from that file's
`result_s3_bucket` (otherwise it looks in `spawn-results-<region>`):

```sh
spawn queue results my-pipeline-001 --config pipeline.json --output-dir ./results
```

`spawn queue template list` shows pre-built queue configurations; `show`,
`generate` and `init` turn one into a queue file, and `spawn launch
--queue-template <name> --template-var KEY=VALUE` launches one directly.

The queue tracks per-job completion state, so a queue that was interrupted resumes
from where it left off — **already-completed jobs are skipped** rather than re-run.
On a job failure, `on_failure: stop` halts the queue (default) while `continue`
moves on to the next job. The instance auto-terminates (or stops) when the queue
completes.

::: warning Spot interruption mid-queue
On a Spot instance, an interruption ends the *machine* mid-queue. Because the whole
queue runs on one instance, in-progress local state is lost unless a
[`--pre-stop`](/guides/plugins#data-movement-patterns) hook or per-job
`result_paths` has already synced it out. For work that must survive interruption,
either run on-demand or checkpoint each job's outputs to S3 via `result_paths`.
:::

## Example: ML training pipeline

```json
{
  "queue_id": "classifier-pipeline-001",
  "queue_name": "classifier-pipeline",
  "jobs": [
    {
      "job_id": "download",
      "command": "aws s3 cp s3://my-bucket/data/ /data/ --recursive",
      "timeout": "20m"
    },
    {
      "job_id": "preprocess",
      "command": "python preprocess.py",
      "timeout": "1h",
      "depends_on": ["download"]
    },
    {
      "job_id": "train",
      "command": "python train.py --epochs 50",
      "timeout": "6h",
      "depends_on": ["preprocess"]
    },
    {
      "job_id": "upload-results",
      "command": "aws s3 cp /models/ s3://my-bucket/models/ --recursive",
      "timeout": "10m",
      "depends_on": ["train"]
    }
  ],
  "global_timeout": "8h",
  "on_failure": "stop"
}
```

```sh
spawn launch classifier \
  --instance-type g5.xlarge \
  --spot \
  --batch-queue pipeline.json \
  --ttl 10h
```
