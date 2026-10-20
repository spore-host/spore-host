---
description: "spore.host provides native execution adapters for six workflow engines — run each task on its own ephemeral EC2 instance. All are early / experimental."
---

# Workflow Adapters

spore.host provides **native execution adapters** for six workflow engines. In
every case the model is the same: each task/step/job/rule runs on its own
**purpose-sized, ephemeral EC2 instance** that auto-terminates when it finishes —
no cluster, no queue, no standing capacity. You keep writing your workflow in the
engine you already use; spawn just runs the work.

Each adapter is a small, versioned package that plugs into the engine's own
extension point (Pegasus, which has none, uses a per-job wrapper instead). All six
dispatch through the same contract: the adapter translates the engine's task into a
spawn **TaskSpec** and runs it with `spawn task run --spec <file>`. spawn sizes the
instance (truffle is built in), stages files through S3, runs the command (in a
container if the task names one), writes a durable completion record to S3, and
the instance terminates itself (`on_complete: terminate` plus a TTL backstop).
The adapter reads the exit status from that record, so the result outlives the
instance.

::: warning These adapters are early — read the maturity matrix first
"Native adapter" means **we build and maintain it**; it does **not** mean
production-ready. All six are early-stage, pre-1.0 releases; nf-spawn and
pegasus-spawn describe themselves as prototypes. Validate against your own
workflow and budget before relying on one.
:::

## Maturity & compatibility

| Engine (adapter) | Status | Latest | Real-AWS validation | Enable it with |
|------------------|--------|--------|---------------------|----------------|
| **Nextflow** (`nf-spawn`) | <span class="doc-badge experimental">Experimental</span> prototype — not production-ready | v0.11.0 | unit/integration | `executor = 'spawn'` in `nextflow.config` |
| **WDL** (`miniwdl-spawn`) | <span class="doc-badge experimental">Experimental</span> early | v0.3.0 | verified end-to-end ([#395](https://github.com/spore-host/spore-host/issues/395)) | `miniwdl run … --cfg scheduler.container_backend=spawn` |
| **CWL** (`cwl-spawn`) | <span class="doc-badge experimental">Experimental</span> early | v0.3.0 | verified end-to-end, leak-checked | `cwl-spawn workflow.cwl inputs.yml` |
| **Snakemake** (`snakemake-executor-plugin-spawn`) | <span class="doc-badge experimental">Experimental</span> early | v0.4.0 | verified end-to-end, leak-checked | `snakemake --executor spawn` |
| **Apache Airflow** (`airflow-spawn`) | <span class="doc-badge experimental">Experimental</span> early | v0.3.0 | verified end-to-end, leak-checked | `SpawnRunTaskOperator(...)` in a DAG |
| **Pegasus WMS** (`pegasus-spawn`) | <span class="doc-badge experimental">Experimental</span> feasibility prototype | v0.1.0 | verified end-to-end, leak-checked | `pegasus-spawn-run` as the job executable in the Transformation Catalog (`site: local`) |

Repos: [nf-spawn](https://github.com/spore-host/nf-spawn) ·
[miniwdl-spawn](https://github.com/spore-host/miniwdl-spawn) ·
[cwl-spawn](https://github.com/spore-host/cwl-spawn) ·
[snakemake-executor-plugin-spawn](https://github.com/spore-host/snakemake-executor-plugin-spawn) ·
[airflow-spawn](https://github.com/spore-host/airflow-spawn) ·
[pegasus-spawn](https://github.com/spore-host/pegasus-spawn). Each repo's README and
CHANGELOG are the authoritative status; the table above summarizes them.

The three [AWS HealthOmics](https://aws.amazon.com/healthomics/)-supported
languages — **Nextflow, WDL, CWL** — were prioritized first for life-sciences
relevance (spore.host is a cost-efficient alternative to HealthOmics, not a client
of it). **Snakemake**, **Airflow**, and **Pegasus** followed on demand.

Not sure a workflow engine is the right layer at all? See
[Which execution tool?](/guides/choosing-execution).

## Which one?

- **Already have a Nextflow / WDL / CWL / Snakemake / Pegasus workflow?** Use the
  matching adapter — your workflow runs unchanged; only the executor changes, so
  the engine still owns parsing, scheduling, scatter/gather, and output collection.
- **Bioinformatics / nf-core pipelines?** → **Nextflow** ([guide](/guides/nextflow)).
- **Prefer declarative per-task resources with auto-sizing?** WDL, CWL, and
  Snakemake all declare CPU/RAM, which the adapter puts in the TaskSpec so spawn
  picks the cheapest fitting instance automatically.
- **Orchestrating a broader DAG (not just a bioinformatics pipeline)?** →
  **Airflow**: add a `SpawnRunTaskOperator` task wherever you want a step to run
  on an ephemeral instance. It's deferrable, so wide fan-out DAGs don't pin a
  worker slot per in-flight instance.

## Sizing

Where the engine declares resources, the adapter passes them in the TaskSpec and
spawn sizes the instance itself (cheapest instance that fits, via the truffle code
built into spawn):

- **Nextflow** — `ext.instanceType` (explicit) per process.
- **WDL** — `runtime { cpu, memory }` → auto-sized. `spawn_instance_type` steers
  the instance **family** (e.g. `c7i.4xlarge` → `c7i`); spawn still picks the
  cheapest fit within it.
- **CWL** — `ResourceRequirement` (`coresMin`/`ramMin`) → auto-sized.
- **Snakemake** — `threads` + `resources: mem_mb` → auto-sized
  (`--spawn-instance-type` steers the family).
- **Airflow** — `cpus=` / `memory_gib=` on the operator → auto-sized.
  `instance_type=` steers the family rather than pinning an exact type.
- **Pegasus** — `PEGASUS_SPAWN_CPU` / `PEGASUS_SPAWN_MEMORY_GIB` env profiles on
  the transformation → auto-sized (`PEGASUS_SPAWN_INSTANCE_TYPE` pins an exact
  type).

To see which instance types fit a request, cheapest first, run `truffle find`
yourself (for example `truffle find "cheap 8 cores 32gb"`).

## Requirements (all engines)

- [spawn](https://github.com/spore-host/spawn) on `PATH`. spawn sizes instances
  with its built-in truffle, so no adapter needs a separate `truffle`
  CLI.
- AWS credentials configured
- An S3 location for the work/exit-code bridge (each engine's docs name the exact
  flag or env var)

Every task launches with a **TTL backstop** and `on_complete: terminate`, so a
run can't leak billable instances even if a step is interrupted.

## No native adapter yet

Snakemake, Airflow, and Pegasus gained native adapters on demand. Others —
Prefect, Argo Workflows, Dagster, Luigi, Temporal, AWS Step Functions — currently
have example patterns (spawn invoked as a launcher via `spawn pipeline` /
`spawn queue`) rather than a native adapter. If you need one, open an issue.

## Building a new adapter

Write the TaskSpec, not the machinery. Since
[spawn#386](https://github.com/spore-host/spawn/issues/386) (closed July 2026),
sizing, S3 staging, the scoped IAM profile, the container run, and the durable
completion record all live in `spawn task run`. A new adapter translates its
engine's task object into a TaskSpec JSON file, dispatches
`spawn task run --spec <file>` (with `--wait`, or detached and then polled with
`spawn task status`), and reads the exit code from the completion record.
[Tasks and worker pools](/guides/tasks-and-pools) documents every TaskSpec field
and the completion record. Read the state as well as the exit code: an output that
failed to upload is `failed` with exit code 0 in the record. (`--wait` exits 1 for
it since spawn v0.135.2.)
`spawn task run --spec <file> --dry-run` sizes and previews a spec without
launching. See [`spawn task run`](/tools/reference/spawn#spawn-task-run) for the
flags, and any of the six adapters above as a working example.

## See also

- [Which execution tool?](/guides/choosing-execution) — adapter vs. sweep vs. pipeline vs. native engine
- [Nextflow adapter guide](/guides/nextflow)
- [Pipelines](/guides/pipelines) — the engine-agnostic `spawn pipeline` / `spawn queue`
- [Instance sizing with truffle](/tools/truffle)
