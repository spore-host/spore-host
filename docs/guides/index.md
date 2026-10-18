---
description: "Complete, end-to-end workflows for the things researchers actually do — start with a story that matches your goal."
---

# Common Workflows

You usually arrive with a goal, not a tool in mind. Start with the story closest to
what you're trying to do — each is a complete, end-to-end walkthrough — then branch
into the deeper guides. New to spore.host? Do [Your first
instance](/guides/first-instance) first; it's the 15-minute backbone the stories
below build on.

::: tip Running more than one thing?
spore.host has several ways to run work at scale — instance plugins, sweeps,
arrays, instance queues, pipelines, MPI, and workflow-engine adapters. If you're
not sure which fits, start with **[Which execution tool?](/guides/choosing-execution)**.
:::

## Story A — Interactive research workstation

*"I need a big machine for a few hours to explore some data, then it should go
away."*

```sh
# 1. find a fit
truffle find "amd genoa 64gb" --region us-east-1
# 2. launch with guards
spawn launch analysis \
  --instance-type m8a.4xlarge \
  --ttl 8h \
  --idle-timeout 30m
# 3. work on it
spawn connect analysis
# 4. done — tear it down
spawn terminate analysis
```

- **`--ttl 8h`** is the hard deadline — the instance terminates then no matter
  what, so a forgotten session can't run all weekend.
- **`--idle-timeout 30m`** stops it early if you wander off; any activity resets
  the timer. Idle *stops*, TTL *terminates* — see [Costs & safety
  guarantees](/safety).
- **Cost:** capped at 8 × the hourly rate; usually far less because idle stops it.
  Check the rate with `truffle spot m8a.4xlarge` before you launch.

→ Deeper: [Finding the right instance](/guides/finding-instances) ·
[Jupyter/RStudio](/guides/jupyter) · [Managing instances &
data](/guides/managing-instances)

## Story B — Unattended batch computation

*"Run this script on a big box; when it finishes, terminate — I'm not watching."*

```sh
spawn launch simulation \
  --instance-type c8a.12xlarge \
  --ttl 12h \
  --command "./run-model.sh" \
  --on-complete terminate
```

What happens in each case:

- **Succeeds** → the command exits 0, spawn writes the completion sentinel, and
  `--on-complete terminate` tears the instance down.
- **Fails** → the command exits non-zero, and the same thing happens: the exit
  code goes to `/tmp/SPAWN_EXITCODE`, the sentinel records the failure, and the
  instance terminates. The end of the command log is copied to the serial
  console first, so `spawn logs simulation` can still show you why. To keep a
  failed instance for debugging, use `--on-complete stop` instead.
- **Hangs** → nothing signals completion. This launch has no idle timeout (one
  only applies by default when neither `--ttl` nor `--idle-timeout` is given), so
  the **TTL** terminates it at 12h. TTL is the backstop that always wins.

A `--command` signals completion when it exits, pass or fail (since v0.113.0).
Work you start some other way, such as over `spawn connect`, has to signal it
with `spored complete`. See
[Troubleshooting](/reference/troubleshooting#a-command-finishing-vs-the-completion-sentinel-appearing).

→ Deeper: [GPU training jobs](/guides/gpu-training) · [Parameter
sweeps](/guides/parameter-sweeps) · [Batch queues](/guides/batch-queue)

## Story C — Scarce GPU capacity

*"I need a p5.48xlarge, but there's never one available when I try."*

1. **[Truffle](/tools/truffle)** confirms the type exists and you have quota.
2. **[Spawn](/tools/spawn)** tries to launch — and gets
   `InsufficientInstanceCapacity`.
3. **[Lagotto](/tools/lagotto)** watches three regions every five minutes.
4. A notification arrives the moment capacity appears.
5. Lagotto launches it automatically with a 6-hour TTL — no one awake required.

This is the one workflow the "find → launch" path can't do alone, because *quota*
and *capacity* are different things. Full walkthrough: [Waiting for scarce
capacity](/guides/waiting-for-capacity).

---

## Choose what to learn next

| I want to… | Go to |
|------------|-------|
| Find the right instance type & compare prices | [Finding the right instance](/guides/finding-instances) |
| Launch from a browser without learning the CLI | [Portal detail levels](/guides/portal-detail-levels) |
| Run Jupyter or RStudio in the browser | [Interactive workstation](/guides/jupyter) |
| Train a model on a GPU | [GPU training jobs](/guides/gpu-training) |
| Save up to 90% with Spot | [Spot instances](/guides/spot-instances) |
| Move data on and off instances | [Managing instances & data](/guides/managing-instances) |
| Run one job across many parameters | [Parameter sweeps](/guides/parameter-sweeps) |
| Manage a group of related instances | [Job arrays](/guides/job-arrays) |
| Queue more work than fits at once | [Batch queues](/guides/batch-queue) |
| Run tightly-coupled multi-node jobs | [MPI clusters](/guides/mpi) |
| Chain jobs so each stage launches the next | [Pipelines](/guides/pipelines) |
| Wait for a hard-to-find GPU | [Waiting for scarce capacity](/guides/waiting-for-capacity) |
| Control instances from Slack/Teams/Discord | [Slack Setup](/guides/slack-setup) |
| Drive compute from an AI assistant | [AI Assistant (MCP)](/guides/mcp-setup) |
| Automate from Python | [Python SDK](/guides/python-sdk) |
| Run Nextflow / WDL / CWL / Snakemake / Airflow | [Workflow engines](/guides/workflow-engines) |
