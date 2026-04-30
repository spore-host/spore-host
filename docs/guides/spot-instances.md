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

The `--pre-stop` command has up to 5 minutes to complete (configurable with `--pre-stop-timeout`). For most checkpoint saves, 60–90 seconds is sufficient.

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

Some instance types have much more stable Spot availability than others. Use truffle to compare:

```sh
truffle find "nvidia gpu" --spot --sort-by-price --region us-east-1
```

Types with high availability tend to be larger families (more AZs, more capacity pool) and slightly older generations.
