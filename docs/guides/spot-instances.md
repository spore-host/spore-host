---
description: "EC2 Spot instances run on AWS's spare capacity at 60–90% below on-demand price."
---

# Spot Instances

EC2 Spot instances run on AWS's spare capacity at 60–90% below on-demand price. In exchange, AWS can reclaim them with two minutes' notice. For batch workloads, training jobs, and anything that can checkpoint progress, Spot is the right default.

## Typical savings

| Instance | On-Demand | Spot (typical) | Savings |
|----------|-----------|----------------|---------|
| c7i.large | $0.085/hr | $0.026/hr | 70% |
| g5.xlarge | $1.006/hr | $0.302/hr | 70% |
| p3.2xlarge | $3.060/hr | $0.918/hr | 70% |
| p4d.24xlarge | $32.77/hr | $9.83/hr | 70% |

## Launch on Spot

```sh
spawn launch --name training --instance-type g5.xlarge --spot --ttl 8h
```

spore.host will request a Spot instance. If no capacity is available, it fails immediately with a clear error rather than hanging.

## Check Spot prices first

```sh
truffle spot g5.xlarge --regions us-east-1,us-west-2,eu-west-1
```

The output always includes On-Demand and Savings columns, so you can see the real discount per AZ (on-demand rates are pulled live from the AWS Price List API). Without `--regions`, `truffle spot` checks every enabled region; add `--limit N` to show only the first N rows.

::: tip Finding the right instance type
Not sure which instance to use? See [Finding the Right Instance](/guides/finding-instances) for a step-by-step walkthrough: `truffle find` → `truffle spot` → `truffle quotas`.
:::

Spot prices vary by region and AZ — sometimes significantly. Running in `us-west-2` instead of `us-east-1` can save an additional 20–30% on the already-discounted Spot price.

## Diversify across instance types

If your workload runs on several instance families, specifying multiple types increases the chance of getting capacity:

```sh
spawn launch \
  --spot \
  --instance-type g5.xlarge,g4dn.xlarge,g5.2xlarge \
  --ttl 8h
```

spore.host picks whichever type has available capacity first, using the lowest current Spot price.

## Handling interruptions

When AWS reclaims a Spot instance, spored receives a two-minute warning via the instance metadata service. It immediately:

1. Sends a `spot_interrupt` notification to Slack/Teams (if configured)
2. Runs your `--pre-stop` hook (if set) — use this to save a checkpoint
3. Terminates gracefully

Configure a checkpoint save:

```sh
spawn launch \
  --spot \
  --instance-type p4d.24xlarge \
  --ttl 12h \
  --pre-stop "python /home/ubuntu/save_checkpoint.py" \
  --slack-workspace T03NE3GTY
```

The `--pre-stop` command has up to **90 seconds** to complete on Spot instances — AWS provides only a 2-minute interruption notice and spored needs the remainder for DNS cleanup and shutdown. On non-Spot instances the default is 5 minutes. Override with `--pre-stop-timeout`. For most checkpoint saves, 60–90 seconds is sufficient.

A `--spot` launch that can be stopped (an idle timeout, `--on-idle`, or
`--on-complete stop`) uses a *persistent* Spot request. Terminate such an instance
with `spawn terminate`, not the EC2 console: terminating it outside spawn reopens
the request and launches an untagged replacement. See
[Spot requests](/guides/reaper#spot-requests) for how spored and the reaper clean
those up.

## Resuming after interruption

If you save a checkpoint on interruption, relaunch and resume from it:

```sh
spawn launch \
  --spot \
  --instance-type p4d.24xlarge \
  --ttl 12h \
  --command "python train.py --resume-from s3://my-bucket/checkpoints/latest/"
```

## When not to use Spot

- **Interactive sessions** — a mid-session interruption is disruptive; use on-demand
- **Jobs that cannot checkpoint** and take more than a few hours
- **Strict deadlines** — Spot capacity isn't guaranteed at launch time

## Finding consistently available types

Some instance types have much more stable Spot availability than others. `truffle available` reports how obtainable a type is right now in one region, including the Spot placement score: a 1–10 likelihood per AZ, relative rather than a guarantee.

```sh
truffle available g5.xlarge --region us-east-1
```

It also shows where the type is offered, your On-Demand quota headroom, and any purchasable Capacity Blocks. Each signal is reported separately; if one is unavailable (Spot placement scores are often denied by an SCP), it is shown as a warning, not as a good result. Run it once per region you're considering.

To compare prices for the same type, use `truffle spot`:

```sh
truffle spot g5.xlarge --sort-by-price --active-only
```

`--sort-by-price` orders cheapest-first and `--active-only` hides AZs with no active Spot capacity. These Spot flags live on `truffle spot`, not `truffle find`.

Types with high availability tend to be larger families (more AZs, more capacity pool) and slightly older generations.
