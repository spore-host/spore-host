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
  --command "python process.py --shard {index} --total 8"
```

Each instance receives its zero-based index as `{index}` and knows the total count as `{total}`. Instance 0 processes shard 0, instance 1 processes shard 1, and so on.

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
spawn list --job-array data-proc         # all instances in the array
spawn status data-proc-0                 # head instance
spawn terminate --job-array data-proc    # terminate all
spawn extend --job-array data-proc 2h    # extend all at once
```

## Available template variables

Inside `--command`, you can use:

| Variable | Value |
|----------|-------|
| `{index}` | This instance's index (0-based) |
| `{total}` | Total instance count |
| `{name}` | This instance's name (e.g. `data-proc-3`) |
| `{job_array_id}` | Unique identifier for the array |

## Collecting results

Each instance typically writes to a path that includes its index:

```sh
spawn launch \
  --count 16 \
  --job-array-name genome-scan \
  --command "python scan.py --region {index} --out s3://my-bucket/scans/{index}/result.json && touch /tmp/SPAWN_COMPLETE" \
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

For workloads where one instance coordinates the others:

```sh
spawn launch \
  --count 8 \
  --job-array-name distributed-train \
  --instance-type p4d.24xlarge \
  --mpi \
  --command "if [ {index} -eq 0 ]; then mpirun -n 64 python train.py; fi"
```

See [MPI Clusters](/guides/mpi) for the full multi-node setup.

## Difference from parameter sweeps

| | Job arrays | Parameter sweeps |
|--|-----------|-----------------|
| Inputs | Identical across instances | Vary per instance |
| Index variable | Yes | Yes |
| Use case | Distributed processing, sharding | Hyperparameter search, sensitivity analysis |
| Config | `--count N` | `--params` or `--param-file` |
