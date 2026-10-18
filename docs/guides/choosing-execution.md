---
description: "spore.host has several ways to run more than one thing — plugins, sweeps, arrays, queues, pipelines, MPI, and workflow adapters. This page picks the right one."
---

# Which execution tool?

Spawn is an execution substrate with several extension layers, and they solve
**different** problems — they aren't ranked alternatives. Start here before diving
into any individual guide; then follow the link.

## The layers at a glance

| Layer | The question it answers |
|-------|-------------------------|
| **[Instance plugin](/guides/plugins)** | What software or service should exist on an instance? |
| **[Parameter sweep](/guides/parameter-sweeps)** | How do I run one command over varying parameters? |
| **[Job array](/guides/job-arrays)** | How do I run indexed copies of the same workload? |
| **[Instance queue](/guides/batch-queue)** | How do I run several dependent steps *sequentially on one machine*? |
| **[Spawn pipeline](/guides/pipelines)** | How do I run a DAG of coarse stages *across different machines*? |
| **[MPI cluster](/guides/mpi)** | How do I run tightly-coupled code across many nodes at once? |
| **[Workflow adapter](/guides/workflow-engines)** | How does my existing workflow engine use spawn as its executor? |

## By what you're trying to do

| I want to… | Use |
|------------|-----|
| Install RStudio, Tailscale, or Globus on an instance | [Instance plugin](/guides/plugins) |
| Run one command over several parameter values | [Parameter sweep](/guides/parameter-sweeps) |
| Divide one dataset into indexed shards | [Job array](/guides/job-arrays) |
| Run several steps on one instance (shared local data/env) | [Instance queue](/guides/batch-queue) |
| Use different machines for a few coarse stages | [Spawn pipeline](/guides/pipelines) |
| Run tightly-coupled parallel code (one job, many nodes) | [MPI cluster](/guides/mpi) |
| Already have a Nextflow / WDL / CWL / Snakemake workflow | The [matching adapter](/guides/workflow-engines) |
| Add one heavy compute step to a business/ETL DAG | [Airflow operator](/guides/workflow-engines) |
| Run a large, complex scientific DAG | An established workflow engine via its [adapter](/guides/workflow-engines) — **not** a spawn pipeline |

## The two easy-to-confuse pairs

**Sweep vs. array.** A [sweep](/guides/parameter-sweeps) runs the same command over
*different declared parameter values* (one instance per combination). An
[array](/guides/job-arrays) runs the *same workload* with *index-based
partitioning*: each member gets `$JOB_ARRAY_INDEX` and `$JOB_ARRAY_SIZE` and
processes its own shard.

**Instance queue vs. pipeline.** An [instance queue](/guides/batch-queue) runs
multiple dependent steps **sequentially on one machine** — ideal when the steps
share large local files, packages, or model weights and you don't want to pay to
boot (and re-stage) a machine per step. A [pipeline](/guides/pipelines) runs a
**DAG across separate machines**, so each stage can use different (and
differently-sized) compute, with data handed off through S3.

## When *not* to use a spawn pipeline

`spawn pipeline` is a compact orchestrator for **small, coarse, infrastructure-shaped
DAGs** — tens of stages, not millions of tasks. It deliberately does not do
advanced caching, dynamic DAG generation, nested workflows, or a rich conditional
language. For complex scientific pipelines (per-sample fan-out, scatter/gather,
resume/caching semantics), use a real workflow engine through its
[adapter](/guides/workflow-engines) and let spawn be the executor underneath.

## When per-task ephemeral instances fit — and when they don't

Every layer here launches (and pays to boot) at least one EC2 instance per unit of
work. That's a great fit for some shapes and a poor one for others:

- **Good fit:** tasks lasting tens of minutes to hours; heterogeneous resource
  needs per task; full-VM requirements; expensive accelerators you only want for
  the duration of the work.
- **Poor fit:** thousands of sub-minute tasks; extremely chatty workflows; tasks
  needing shared POSIX state; pipelines dominated by repeated environment setup.
  For those, prefer an [instance queue](/guides/batch-queue) (batch the steps onto
  one machine) or a standing cluster / AWS Batch.

See also [Costs & safety guarantees](/safety) for how the TTL bounds the cost of
any of these.
