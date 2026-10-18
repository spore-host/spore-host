---
description: "A pipeline chains stages together: when one stage completes, it automatically launches the next."
---

# Pipelines

A pipeline chains stages together: when one stage completes, it automatically launches the next. This is useful for multi-step workflows — data preparation, training, evaluation, post-processing — where each stage has different compute requirements.

## What each stage looks like

A pipeline is a DAG of stages, each of which is one ephemeral instance with its own
instance type, TTL, and completion behavior. On its own, a single stage is just a
`spawn launch` that terminates when its `--command` exits (the command's exit,
pass or fail, writes the completion file `/tmp/SPAWN_COMPLETE` for you):

```sh
# One stage in isolation — data prep on a cheap CPU instance
spawn launch \
  --name pipeline-prep \
  --instance-type c6i.4xlarge \
  --ttl 4h \
  --on-complete terminate \
  --s3-write my-bucket \
  --command "python prepare_data.py --output s3://my-bucket/prepared/"
```

::: warning Running stages by hand does **not** create a pipeline
`--on-complete` controls what happens to *this* instance when it finishes
(terminate/stop/hibernate) — it does **not** launch the next stage. Chaining
between stages is done by the orchestrator from a pipeline definition (below), not
by `--on-complete`. Launching two `spawn launch` commands manually just gives you
two independent instances.
:::

## Automated pipeline definition

To actually chain stages, define the whole DAG in a **pipeline definition file** and let a Lambda orchestrator manage the handoffs. `spawn pipeline launch` uploads the definition to S3 and starts the orchestrator, which launches each stage when its dependencies complete.

The definition is JSON. Stages declare their dependencies with `depends_on`, so the pipeline is a DAG — independent stages run in parallel, dependent ones wait:

```json
{
  "pipeline_id": "ml-pipeline",
  "pipeline_name": "Training pipeline",
  "s3_bucket": "my-bucket",
  "s3_prefix": "pipelines/ml-pipeline",
  "on_failure": "stop",
  "stages": [
    {
      "stage_id": "prep",
      "instance_type": "c6i.4xlarge",
      "instance_count": 1,
      "command": "python prepare_data.py --output s3://my-bucket/prepared/",
      "timeout": "4h"
    },
    {
      "stage_id": "train",
      "instance_type": "p4d.24xlarge",
      "instance_count": 1,
      "spot": true,
      "depends_on": ["prep"],
      "command": "python train.py --data s3://my-bucket/prepared/",
      "timeout": "24h"
    },
    {
      "stage_id": "eval",
      "instance_type": "c6i.2xlarge",
      "instance_count": 1,
      "depends_on": ["train"],
      "command": "python evaluate.py --model s3://my-bucket/model/",
      "timeout": "2h"
    }
  ]
}
```

`pipeline_id`, `pipeline_name`, `s3_bucket` and at least one stage are required.
Every stage needs `stage_id`, `instance_type`, `command`, and an `instance_count`
of at least 1; there is no default, so a stage without it fails validation. The
pipeline's stage markers, outputs and config live in `s3_bucket` under
`<s3_prefix>/runs/<run-id>/`.

Check the definition, preview the DAG, then launch:

```sh
spawn pipeline validate pipeline.json  # required fields, dependencies, no cycles
spawn pipeline graph pipeline.json     # ASCII render of the dependency graph
spawn pipeline launch pipeline.json    # upload + start the orchestrator
spawn pipeline launch pipeline.json --wait   # block until the pipeline finishes
```

Each stage launches automatically once every stage in its `depends_on` list has succeeded. Set `"on_failure": "continue"` at the top level to keep running independent branches when one stage fails (the default, `"stop"`, halts the pipeline).

::: tip Scope: coarse DAGs, not a scientific workflow engine
`spawn pipeline` is a compact orchestrator for **small, coarse, infrastructure-shaped
DAGs** — on the order of tens of stages, each a substantial chunk of compute. It
deliberately does **not** do per-sample fan-out, dynamic DAG generation, nested
workflows, advanced caching, or a rich conditional language. For complex scientific
pipelines (scatter/gather over thousands of samples, resume/caching semantics), use
a real workflow engine through its [adapter](/guides/workflow-engines) and let spawn
be the executor underneath. See [Which execution tool?](/guides/choosing-execution).
:::

## Passing data between stages

Stages hand data off through S3. Give a stage a `data_output` block to publish its results, and a downstream stage a `data_input` block naming the source stage — the orchestrator wires the S3 locations so the consumer downloads them before its command runs:

```json
{
  "stage_id": "prep",
  "instance_type": "c6i.4xlarge",
  "instance_count": 1,
  "command": "python prepare_data.py --output /mnt/out/",
  "data_output": { "mode": "s3", "paths": ["/mnt/out/"] }
},
{
  "stage_id": "train",
  "instance_type": "p4d.24xlarge",
  "instance_count": 1,
  "depends_on": ["prep"],
  "data_input": { "mode": "s3", "source_stage": "prep", "dest_path": "/mnt/data" },
  "command": "python train.py --data /mnt/data"
}
```

### Streaming between stages <span class="doc-badge experimental">Experimental</span>

For tightly-coupled stages that stream rather than stage through S3, use
`"mode": "stream"` with a `protocol` (`tcp`, `grpc`, or `zmq`) and `port`; the
orchestrator discovers peer addresses across stages.

::: warning Streaming is operationally involved
Unlike the S3 handoff, streaming couples two live instances directly: it depends on
security-group rules, service startup ordering and readiness, reconnect behavior,
private-vs-public addressing/VPC, and how a Spot interruption mid-stream is handled.
Treat it as experimental and test it end-to-end for your topology before relying on
it; most pipelines should prefer the S3 `data_input`/`data_output` handoff above.
:::

## Error handling

If a stage exits non-zero the pipeline stops (unless `on_failure` is `continue`). Fix the cause and re-launch — re-running `spawn pipeline launch` starts a fresh run of the definition, with its own run id, so it never reads an earlier run's results.

The `pipeline_id` comes from the file, so a relaunch reuses it. If that pipeline
still has a run in flight, `launch` refuses rather than replacing it. Add
`--replace` to cancel the run in flight (its instances are terminated) and start
the new one:

```sh
spawn pipeline launch pipeline.json --replace
```

## Monitoring

`status`, `cancel`, and `collect` take the **pipeline id** (the `pipeline_id` from the definition); `graph` takes the definition **file**:

```sh
spawn pipeline list                    # all pipelines and their state
spawn pipeline status ml-pipeline      # current stage, run id, elapsed time, cost
spawn pipeline collect ml-pipeline     # download the latest run's results to ./results
spawn pipeline cancel ml-pipeline      # stop the current stage and all remaining
```

`collect` downloads every stage's `data_output` files to
`<output-dir>/<stage>/<file>` (with an `<index>/` level for a stage with
`instance_count` above 1). It collects the latest run unless you name another
with `--run` (the run id printed at launch and by `status`):

```sh
spawn pipeline collect ml-pipeline --run <run-id> --output-dir ./run-results
spawn pipeline collect ml-pipeline --stage train
```
