---
description: "A parameter sweep runs the same job across many combinations of input parameters, each on its own instance, in parallel."
---

# Parameter Sweeps

A parameter sweep runs the same job across many combinations of input parameters, each on its own instance, in parallel. It's useful for hyperparameter search, sensitivity analysis, and any scenario where you want to explore a parameter space without waiting for jobs to run sequentially.

## The basic pattern

A sweep is driven by a **parameter file** (`--param-file`, YAML/JSON/CSV): `defaults` shared by every instance, plus a `params` list where each entry is one combination to launch.

```yaml
# sweep.yaml
defaults:
  instance_type: g5.xlarge
  ttl: 4h
  on_complete: terminate
  command: "python train.py --lr $PARAM_learning_rate --batch $PARAM_batch_size"

params:
  - learning_rate: 0.001
    batch_size: 32
  - learning_rate: 0.001
    batch_size: 64
  - learning_rate: 0.01
    batch_size: 32
  - learning_rate: 0.01
    batch_size: 64
```

```sh
spawn launch hp-search --param-file sweep.yaml
```

This launches one instance per `params` entry (4 here). Each runs `command` with its combination in environment variables: every key that isn't a spawn setting becomes `PARAM_<key>` (`$PARAM_learning_rate`, `$PARAM_batch_size`), and `$SWEEP_INDEX` is the entry's 0-based position. Each instance has its own TTL and terminates independently when done.

::: warning `{...}` is not substituted
spawn runs `command` exactly as written. `{learning_rate}` would reach your program
as literal text; use `$PARAM_learning_rate`.
:::

::: tip Preview before you launch
Add `--estimate-only` to see the instance count and cost estimate without launching anything.
:::

## Every combination of several lists

Use `grid:` to sweep the full cartesian product of several lists. spawn expands
it to one parameter set per combination:

```yaml
# grid.yaml: 3 learning rates x 3 batch sizes = 9 instances
defaults:
  instance_type: g5.xlarge
  ttl: 4h
  on_complete: terminate
  command: "python train.py --lr $PARAM_learning_rate --batch $PARAM_batch_size"

grid:
  learning_rate: [0.001, 0.01, 0.1]
  batch_size: [32, 64, 128]
```

```sh
spawn launch grid-search --param-file grid.yaml --estimate-only   # shows 9 instances
spawn launch grid-search --param-file grid.yaml
```

Keys expand in sorted order, so the combinations, and the `$SWEEP_INDEX` each one
gets, are the same every time. `grid:` and an explicit `params:` list can be
combined; the explicit entries come first.

::: info Inline `--params`
Passing parameters on the command line (`--params …`) isn't implemented; the CLI
says *"inline --params not yet implemented, use --param-file for now."* Put them
in a param file.
:::

## Heterogeneous sweeps — vary the instance type per entry

A sweep entry can set its own `instance_type` (and `ami`, `spot`, `region`, `az`), so a single sweep can run the **same workload across different instance families** — the natural shape of a price-performance benchmark. Any field an entry sets overrides the top-level `--instance-type` / `defaults` for that entry only; entries that omit `instance_type` fall back to the CLI `--instance-type`.

```yaml
# gromacs-bench.yaml — one workload, many instance types, compare ns/$
defaults:
  ttl: 2h
  on_complete: terminate
  spot: true
  command: "gmx mdrun -s bench.tpr && aws s3 cp md.log s3://my-bucket/bench/$PARAM_family/"

params:
  - {instance_type: c8i.24xlarge, family: c8i}   # Intel
  - {instance_type: c8a.24xlarge, family: c8a}   # AMD
  - {instance_type: c8g.24xlarge, family: c8g}   # Graviton (arm64)
  - {instance_type: g6.2xlarge,   family: g6}    # NVIDIA L4 GPU
  - {instance_type: g6e.2xlarge,  family: g6e}   # NVIDIA L40S GPU
```

```sh
spawn launch gromacs-bench --param-file gromacs-bench.yaml --s3-write my-bucket
```

spawn detects the right AMI **per entry** from its instance type — an arm64 AMI for `c8g`, a GPU AMI for `g6`/`g6e`, an x86 AMI for `c8i`/`c8a` — so you don't hand-pick an AMI per family (entries sharing an architecture reuse one AMI lookup). Set an explicit `ami:` on an entry to override. `instance_type` is a spawn setting, not a workload parameter, so it isn't exported; the `family` key is, as `$PARAM_family`. Each instance uploads its result under its family, so the comparison falls out of the S3 layout. (`--s3-write` lets the instances write to your bucket; otherwise they can only reach spawn's own.)

::: warning One OS per sweep
A sweep must be all-Linux or all-Windows — a single `command`/lifecycle model can't span both. Mixing an entry that resolves to Windows with Linux entries is rejected before launch.
:::

::: info Detached (Lambda) sweeps
`--detach` sweeps run through the Lambda orchestrator, which uses each entry's explicit `ami:` but does **not** auto-detect one. For a heterogeneous `--detach` sweep, set `ami:` on every entry.
:::

## Monitoring a sweep

```sh
spawn list --sweep-name hp-search     # all instances in the sweep
spawn sweep status <sweep-id>         # summary: running, completed, failed
spawn sweep cancel <sweep-id>         # terminate all remaining instances
```

With Slack connected, you'll get a DM when the sweep finishes (all instances have terminated).

## Controlling concurrency and cost

A large sweep does not have to launch every instance at once. Two launch flags cap
how wide and how expensive it gets:

```sh
# --max-concurrent: at most 8 instances running at a time (0 = unlimited)
# --budget: stop launching once projected spend hits $200 (0 = no limit)
spawn launch hp-search --param-file sweep.yaml \
  --max-concurrent 8 \
  --budget 200 \
  --ttl 4h
```

`--max-concurrent` (or `--max-concurrent-per-region`) queues the remaining entries
and starts them as running ones finish — useful for staying under an instance-family
quota. `--budget` is a spend ceiling for the whole sweep.

## Resuming an interrupted sweep

Sweeps checkpoint their progress, so a sweep that was cancelled or partially
launched can be resumed without re-running the entries that already completed:

```sh
spawn sweep resume <sweep-id>                     # continue from checkpoint
spawn sweep resume <sweep-id> --max-concurrent 5  # optionally re-cap concurrency
```

Gather the results of a finished sweep into one place with:

```sh
spawn sweep collect <sweep-id> --output-file results.json
```

::: info Re-running only the failed entries
Sweeps have no "retry only the failed entries" command; `resume` continues
incomplete work from the checkpoint. (Job arrays do: `spawn array retry --failed`.)
:::

## Collecting results

Each instance writes its results to a path you control — typically S3. The convention is to include the sweep index or parameters in the path:

```sh
spawn launch hp-search \
  --instance-type g5.xlarge \
  --param-file sweep.yaml \
  --s3-write my-bucket \
  --command 'python train.py --lr $PARAM_learning_rate && aws s3 cp results.json s3://my-bucket/sweeps/hp-search/$SWEEP_INDEX/results.json' \
  --on-complete terminate
```

Each instance has `$SWEEP_INDEX` (its 0-based position in the sweep), plus
`$SWEEP_ID`, `$SWEEP_NAME`, `$SWEEP_SIZE` and a `$PARAM_<key>` for every parameter.
Single-quote the command so your own shell doesn't expand them first. The
command's exit signals completion, so `--on-complete` fires when it finishes.

## Cost estimation

Before launching a large sweep, use `--estimate-only` to see the maximum possible cost without launching anything:

```sh
spawn launch hp-search \
  --instance-type g5.xlarge \
  --param-file sweep.yaml \
  --ttl 4h \
  --estimate-only
```

This shows the maximum cost if every instance runs for the full TTL. Actual cost is lower because most instances complete before the TTL.

## Next steps

- [Job Arrays](/guides/job-arrays) — for when you want a fixed count of identical instances rather than parameterised jobs
- [Pipelines](/guides/pipelines) — chain sweeps so stage 2 launches after stage 1 completes
