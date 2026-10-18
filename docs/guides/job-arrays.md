---
description: "A job array launches a fixed number of identical instances as a named group."
---

# Job Arrays

A job array launches a fixed number of identical instances as a named group. Unlike [parameter sweeps](/guides/parameter-sweeps), which vary inputs across instances, job arrays run the same workload on every instance — useful for distributed processing, redundant jobs, or fan-out patterns where each instance handles a chunk of work determined by its own index.

## Basic launch

```sh
spawn launch \
  --name data-proc \
  --count 8 \
  --instance-type c6i.2xlarge \
  --ttl 4h \
  --job-array-name data-proc \
  --command 'python process.py --shard $JOB_ARRAY_INDEX --total $JOB_ARRAY_SIZE'
```

Each instance gets its zero-based index in `$JOB_ARRAY_INDEX` and the array's size in `$JOB_ARRAY_SIZE`. Instance 0 processes shard 0, instance 1 processes shard 1, and so on.

::: warning Use the environment variables, in single quotes
`--command` is run exactly as written; spawn substitutes nothing in it. `{index}`
or `{total}` would reach your program as literal text. Put the command in
**single** quotes so your own shell doesn't expand `$JOB_ARRAY_INDEX` (to
nothing) before spawn sees it.
:::

## Instance naming

Instances in a job array are named `{job-array-name}-{index}`:

```
data-proc-0
data-proc-1
...
data-proc-7
```

Use these names directly in `spawn status` and Slack commands.

## Managing the array

```sh
spawn list --job-array-name data-proc       # all instances in the array
spawn status data-proc-0                     # head instance
spawn stop --job-array-name data-proc        # stop all
spawn extend --job-array-name data-proc 2h   # extend all at once
spawn terminate --job-array-name data-proc   # permanently terminate the whole array
```

## Partial success (`--min-viable`)

Spot capacity can be uneven — you ask for 8 instances but only 6 land. By default
a job array succeeds if **at least one** member launches. Set a floor with
`--min-viable`:

```sh
spawn launch --name data-proc --count 8 --min-viable 6 \
  --job-array-name data-proc --spot \
  --command 'python process.py --shard $JOB_ARRAY_INDEX --total $JOB_ARRAY_SIZE'
```

If fewer than `--min-viable` members launch, the array is treated as failed and
the launched instances are cleaned up, so you don't pay for a run that can't
complete. Because the members that *did* launch are cleaned up on failure, size
`--min-viable` to the smallest count your job can actually finish with. It
defaults to `1` and is ignored for `--mpi` clusters (which need all ranks — see
the [MPI guide](/guides/mpi)).

::: warning `JOB_ARRAY_SIZE` is the requested count, and indexes can be sparse
`JOB_ARRAY_SIZE` is always the count you **requested** (`--count`), not
the number that actually launched. If you ask for 8 with `--min-viable 6` and only
6 land, each surviving member still sees `JOB_ARRAY_SIZE` = 8, and the launched indexes
are whatever subset succeeded (e.g. 0,1,2,4,5,7) — **there can be gaps**. So a
shard scheme that assumes a dense `0…JOB_ARRAY_SIZE-1` will skip the work of the missing
indexes. If your job must cover every shard, either don't rely on `--min-viable`,
or have the surviving members detect and redistribute the missing indexes.

:::

## Checking, retrying and collecting an array

`spawn array` works on a whole array by name:

```sh
spawn array status data-proc            # members, requested vs launched, missing indexes
spawn array logs data-proc --index 3    # one member's command or spored log
spawn array retry data-proc --failed    # relaunch the missing or failed indexes
spawn array collect data-proc           # where each member's results are
spawn array cancel data-proc            # terminate the array's instances
```

## Environment variables

`--command` and anything else running on the instance see these (set in
`/etc/profile.d/job-array.sh`). There are no `{...}` substitutions in `--command`;
the only templated value is the instance-name pattern above (`--instance-names`).

| Variable | Description |
|----------|-------------|
| `JOB_ARRAY_INDEX` | Zero-based index of this instance |
| `JOB_ARRAY_SIZE` | Total number of instances in the array |
| `JOB_ARRAY_NAME` | Job array name (from `--job-array-name`) |
| `JOB_ARRAY_ID` | Unique array ID (UUID) |

These are available in any shell script or process running on the instance:

```bash
#!/bin/bash
# This script runs on each instance in the array
CHUNK_SIZE=$((TOTAL_RECORDS / JOB_ARRAY_SIZE))
START=$((JOB_ARRAY_INDEX * CHUNK_SIZE))
END=$((START + CHUNK_SIZE))
python process.py --start $START --end $END --output s3://bucket/results/$JOB_ARRAY_INDEX/
```

## Collecting results

Each instance typically writes to a path that includes its index:

```sh
spawn launch \
  --count 16 \
  --job-array-name genome-scan \
  --s3-write my-bucket \
  --command 'python scan.py --region $JOB_ARRAY_INDEX --out s3://my-bucket/scans/$JOB_ARRAY_INDEX/result.json' \
  --on-complete terminate
```

After all instances complete, aggregate from S3:

```python
import boto3
results = [boto3.client('s3').get_object(
    Bucket='my-bucket', Key=f'scans/{i}/result.json'
) for i in range(16)]
```

## Head node pattern

For workloads where one instance coordinates the others, use an MPI array with
`--mpi-command`. Rank 0 runs it through `mpirun` across the whole cohort, and
when it exits every member is signalled to complete:

```sh
spawn launch \
  --count 8 \
  --job-array-name distributed-train \
  --instance-type p4d.24xlarge \
  --mpi \
  --mpi-command 'python train.py'
```

See [MPI Clusters](/guides/mpi) for the full multi-node setup.

## Difference from parameter sweeps

| | Job arrays | Parameter sweeps |
|--|-----------|-----------------|
| Inputs | Identical across instances | Vary per instance |
| Index variable | Yes | Yes |
| Use case | Distributed processing, sharding | Hyperparameter search, sensitivity analysis |
| Config | `--count N` | `--params` or `--param-file` |
