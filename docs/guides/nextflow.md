---
description: "nf-spawn is a Nextflow executor plugin that dispatches each pipeline process step to its own ephemeral EC2 instance — purpose-sized and auto-terminated when…"
---

# Nextflow Adapter (nf-spawn) <span class="doc-badge experimental">Experimental</span>

[nf-spawn](https://github.com/spore-host/nf-spawn) is a Nextflow executor plugin that dispatches each pipeline process step to its own ephemeral EC2 instance — purpose-sized and auto-terminated when the task completes.

This lets you run bioinformatics pipelines (including [nf-core](https://nf-co.re) pipelines) without AWS Batch, ECS, or any queue infrastructure.

::: warning Early prototype
nf-spawn is an **early prototype — not production-ready** (per its
[README](https://github.com/spore-host/nf-spawn)). It's one of six
[workflow adapters](/guides/workflow-engines), each early-stage; see the
[maturity matrix](/guides/workflow-engines#maturity-compatibility). It is not in
the Nextflow plugin registry yet, so you install the release zip by hand (below).
Validate against your own pipeline before relying on it.
:::

## How it works

nf-spawn builds a spawn TaskSpec for each task (the staging script, the instance
type, and a scoped IAM profile) and dispatches it with `spawn task run`. The
instance stages the task's inputs, runs it, stages outputs back, writes
`completion.json` and `.exitcode` to the S3 work directory, and terminates itself.
nf-spawn detects completion by reading `.exitcode` from S3, so the result survives
the instance.

```
Nextflow process → SpawnTaskHandler.submit()
                 → spawn task run --spec <taskspec.json>   (detached)
                 → instance stages inputs, runs the task, stages outputs,
                   writes completion.json + .exitcode to the S3 work dir,
                   then self-terminates
              ← SpawnTaskHandler.checkIfCompleted()
                 → reads <workDir>/.exitcode from S3
                 → present = done (with its exit status); absent = still running
```

By default each task gets a fresh instance. For a wide fan-out, use
[pool mode](#pool-mode-for-wide-fan-out) instead.

## Requirements

- [spawn](https://github.com/spore-host/spawn) on `PATH`
- AWS credentials configured
- Nextflow 26.04.x (the version nf-spawn v0.11.0 is built against)
- A JDK, only if you build the plugin from source

## Installation

nf-spawn is not in the Nextflow plugin registry, so the usual automatic
`plugins { id 'nf-spawn@…' }` resolution does not work. Download the release zip
and unpack it into `~/.nextflow/plugins/` instead:

```bash
VERSION=0.11.0
curl -sSL -o nf-spawn-$VERSION.zip \
    https://github.com/spore-host/nf-spawn/releases/download/v$VERSION/nf-spawn-$VERSION.zip
mkdir -p ~/.nextflow/plugins
unzip -o nf-spawn-$VERSION.zip -d ~/.nextflow/plugins/nf-spawn-$VERSION
```

Nextflow uses a plugin already under `~/.nextflow/plugins/` before it consults
the registry. The version you declare in `nextflow.config` must match the
installed version exactly. To build from source instead, clone the repo and run
`./gradlew installPlugin`. See the
[nf-spawn releases](https://github.com/spore-host/nf-spawn/releases) for newer
versions.

## Configuration

```groovy
// nextflow.config
plugins {
    id 'nf-spawn@0.11.0'   // match the version you installed
}

process {
    executor = 'spawn'

    // Default instance type for all processes
    ext.instanceType = 't3.medium'
    ext.region       = 'us-east-1'
    ext.ttl          = '2h'
    ext.costLimit    = '0.50'   // USD per task; a second ceiling, independent of ttl

    // Per-process overrides
    withName: 'KRAKEN2' {
        ext.instanceType = 'c7g.4xlarge'   // 16 vCPU, 32 GB RAM
        ext.spot         = true
    }
    withName: 'FASTP' {
        ext.instanceType = 't4g.medium'
    }
}

// S3 work directory (required — instances need shared storage)
workDir = 's3://my-bucket/nextflow-work'
```

### Per-process `ext` options

Besides `ext.instanceType`, `ext.region`, `ext.ttl`, and `ext.spot`, nf-spawn reads
these per-process options (the
[nf-spawn README](https://github.com/spore-host/nf-spawn#per-process-ext-options)
has the full table):

| Option | What it does |
|--------|--------------|
| `ext.costLimit` | Per-task spend cap in USD, e.g. `'0.50'`. spored enforces it independently of the TTL, whichever fires first, so a task that hangs stops billing early. |
| `ext.volumes` | Attach EBS volumes from snapshots, e.g. `[[ snapshot: 'snap-0abc', mount: '/opt/databases/kraken2', readOnly: true ]]`. Read-only by default. Good for a reference database at small fan-out. |
| `ext.fsx` / `ext.efs` | Mount an existing shared FSx for Lustre or EFS filesystem by id (`'fs-0abc'`, or `[ id:, mount:, paths: ]`). Every task mounts the same filesystem, which suits one reference database read by a wide fan-out. |
| `ext.az` | Pin the task to an availability zone, e.g. the AZ where a snapshot's Fast Snapshot Restore is enabled. |
| `ext.packages` | Host packages to `dnf install` before the task, as a list or a space/comma-separated string. |
| `ext.setup` | A shell command run on the instance before the task (after Docker and packages). |

### Pool mode for wide fan-out

By default nf-spawn launches one instance per task, so a scatter of hundreds of
short tasks is limited by how fast instances boot. Pool mode instead starts a
fixed set of reusable workers once per run; they pull tasks from a shared queue.
Turn it on in `nextflow.config`:

```groovy
spawn {
    pool {
        enabled      = true          // default false: one instance per task
        workers      = 100           // pool size to request (best-effort)
        minViable    = 1             // proceed once this many workers are up
        instanceType = 'c7i.large'   // every worker is this type
        spot         = false
        idleTimeout  = '5m'          // a worker drains itself after this long idle
        ttl          = '4h'          // per-worker TTL backstop
    }
}
```

All workers share one `instanceType`, so per-process `ext.instanceType` is not
honored in pool mode. Workers terminate themselves after `idleTimeout`, and the
queue is deleted when the run ends. Pool mode requires spawn v0.97.0 or later.

## Example pipeline


```nextflow
process FASTP {
    input:  path reads
    output: path 'trimmed.fastq.gz'
    script:
    """
    fastp -i $reads -o trimmed.fastq.gz --thread ${task.cpus}
    """
}

process KRAKEN2 {
    input:  path reads
    output: path 'report.txt'
    script:
    """
    kraken2 --db /kraken2-db --report report.txt $reads
    """
}

workflow {
    reads = Channel.fromPath('s3://my-bucket/data/*.fastq.gz')
    FASTP(reads) | KRAKEN2
}
```

```bash
nextflow run my-pipeline.nf
```

## Cost model

Each process step runs on its own instance, sized for that step, and you pay only
for the minutes each instance runs. A cheap QC step such as `fastp` can run on a
small `t4g.medium`, while `kraken2` gets a `c7g.4xlarge` (as Spot, in the
configuration above) only for as long as it classifies. To price a step, look up
the instance's current rate with `truffle spot <type>` (Spot) or
`truffle find <type> --show-price` (on-demand), and multiply by the task count
and duration.

No Batch job queue, no ECS cluster, no idle capacity — instances spin up and down per task.

## See also

- [Workflow Engines overview](/guides/workflow-engines) — all six engine integrations
- [nf-spawn on GitHub](https://github.com/spore-host/nf-spawn)
- [`spawn task run` reference](/tools/reference/spawn#spawn-task-run)
- [Instance sizing with truffle](/tools/truffle)
