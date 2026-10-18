---
description: "This guide walks through the full workflow for running a GPU training job: finding the right instance, launching it with a TTL and idle timeout, running the…"
---

# GPU Training Jobs

This guide walks through the full workflow for running a GPU training job: finding the right instance, launching it with a TTL and idle timeout, running the job in tmux so it survives your disconnect, and letting the instance manage its own lifecycle.

::: tip TTL vs idle timeout
`--ttl` is the hard deadline — it terminates the instance at `launch_time + duration`, never reset by stop/wake cycles. `--idle-timeout` stops (or hibernates) the instance when idle, saving compute cost between tasks. The timer resets each time the instance wakes. See [TTL vs idle timeout](/reference/configuration#ttl-vs-idle-timeout-how-they-interact) for the full picture.
:::

## Find an available GPU instance

Start by seeing what's available and what the current Spot prices look like:

```sh
# Find NVIDIA A100 instance types in us-east-1 (p4d, p4de)
truffle find a100 --region us-east-1

# Only the 80 GB A100s (p4de)
truffle find "A100-80GB" --region us-east-1

# Compare Spot prices for those types across all regions, cheapest first
truffle spot p4d.24xlarge p4de.24xlarge --sort-by-price --limit 10

# Check quota before committing
truffle quotas --regions us-east-1 --family P
```

`truffle find` shows each type's specs, on-demand price, and the AZs where it is offered; it searches only your configured region unless you pass `--regions` or `--all-regions`. `truffle spot` shows the current Spot price per AZ in every enabled region, next to the on-demand price and the saving. `--limit 10` keeps the first 10 rows. For training jobs that can tolerate interruption, Spot typically saves 60–90%.

## Launch with a completion signal

The cleanest pattern for training jobs is to use `--on-complete terminate` with a completion file. When your training script finishes, it writes a file to a known path, and spored terminates the instance automatically.

```sh
spawn launch \
  --name llm-training \
  --instance-type p4d.24xlarge \
  --region us-east-1 \
  --spot \
  --ttl 24h \
  --on-complete terminate \
  --completion-file /tmp/SPAWN_COMPLETE \
  --slack-workspace T03NE3GTY
```

In your training script, add this at the end:

```sh
# ... your training code ...

# Signal completion
touch /tmp/SPAWN_COMPLETE
```

When spored sees that file appear, it sends a completion notification to Slack and terminates the instance. The TTL (`--ttl 24h`) acts as a hard upper bound in case something goes wrong — you'll never pay for more than 24 hours even if the job hangs.

## Use Spot with graceful interruption handling

Spot instances can be interrupted by AWS with two minutes' warning. If you have a pre-stop hook that saves a checkpoint, you can resume from where you left off:

```sh
spawn launch \
  --name llm-training \
  --instance-type p4d.24xlarge \
  --spot \
  --ttl 24h \
  --pre-stop "python /home/ubuntu/training/save_checkpoint.py" \
  --on-complete terminate \
  --slack-workspace T03NE3GTY
```

The `--pre-stop` command runs before any lifecycle-triggered shutdown — whether that's Spot interruption, TTL expiry, or idle timeout. spored waits up to 5 minutes for it to complete (configurable with `--pre-stop-timeout`).

## Monitor from Slack

With `--slack-workspace` set, you'll receive DMs for:

- **⏱️ llm-training terminates in 5 minutes** — with time to extend if you need more
- **✅ llm-training has completed** — job done, instance terminating
- **⚠️ llm-training received a Spot interruption notice** — 2 minutes until shutdown

Extend runtime directly from Slack: `/spore extend llm-training 4h`

## Manage cost with hibernation

If your job has natural pauses (waiting for data, multi-phase training), consider hibernation instead of termination:

```sh
spawn launch \
  --name llm-training \
  --instance-type p4d.24xlarge \
  --ttl 48h \
  --hibernate-on-idle \
  --idle-timeout 30m
```

When the instance has been idle for 30 minutes, it hibernates — saving RAM state to the root volume and stopping the clock on compute billing. Resume it with `/spore start llm-training` or `spawn start llm-training`.

::: warning Hibernation requirements
Hibernation requires the instance to be launched with a hibernation-enabled AMI and root volume. Most spore.host AMIs support this, but check your specific AMI documentation. Not all instance types support hibernation.
:::

## Full example: multi-GPU training job

```sh
# 1. Find 8×A100 instance types, then the cheapest Spot price for one
truffle find "a100 8 gpus"
truffle spot p4d.24xlarge --sort-by-price --limit 5

# 2. Launch on Spot with checkpoint support
spawn launch \
  --name bert-finetune \
  --instance-type p4d.24xlarge \
  --region us-east-1 \
  --spot \
  --ttl 12h \
  --pre-stop "python /home/ubuntu/bert/save_checkpoint.py --emergency" \
  --on-complete terminate \
  --completion-file /tmp/SPAWN_COMPLETE \
  --active-processes python \
  --slack-workspace T03NE3GTY

# 3. Watch for it in Slack, or check status any time
spawn status bert-finetune
```

The `--active-processes python` flag tells spored that the instance isn't idle as long as a `python` process is running — preventing premature idle detection even during a phase where CPU looks low (waiting on data I/O, for example).

## Next steps

- [Spot Instances](/guides/spot-instances) — deeper coverage of Spot strategies and interruption handling
- [Parameter Sweeps](/guides/parameter-sweeps) — run the same training job across many hyperparameter combinations in parallel
- [Slack Setup](/guides/slack-setup) — configure the `/spore` Slack commands
