---
description: "A complete walkthrough: use Lagotto to wait for a scarce GPU instance and act the moment capacity appears."
---

# Waiting for scarce capacity

A complete walkthrough for the case where the instance you want isn't available
right now — a scarce GPU family like `p5.48xlarge`. Instead of re-running a launch
by hand, you'll set [Lagotto](/tools/lagotto) to watch for capacity and act the
moment it appears. Allow about 15 minutes.

## What you'll accomplish

- A Lagotto watcher deployed in your own AWS account
- A watch that checks three regions every five minutes
- A notification the moment capacity is found — with no automatic launch
- Then: the same watch upgraded to **launch automatically** with a TTL

## Prerequisites

- [truffle and spawn installed and working](/guides/first-instance) and AWS
  credentials verified
- lagotto installed: `brew install spore-host/tap/lagotto`
- Confirm you're actually allowed to launch the type you want *before* you wait for
  it — see the four questions below

## First, know which question you're answering

Capacity is the last of four different questions, and only Lagotto answers it.
Don't skip the first three — waiting for capacity you have no quota for is wasted
time:

| Question | Answered by |
|----------|-------------|
| Does this EC2 type exist in this region? | [Truffle](/tools/truffle) — `truffle find` / `truffle az` |
| Am I allowed to launch it under my quota? | [Truffle](/tools/truffle) — `truffle quotas` |
| Can AWS actually place one *right now*? | [Spawn](/tools/spawn) launch attempt / Lagotto |
| Should I keep checking until placement succeeds? | **[Lagotto](/tools/lagotto)** |

```sh
truffle quotas --regions us-east-1,us-west-2,us-east-2 --family P
```

If quota is zero, request an increase first — Lagotto can't launch what your quota
forbids (that's a *terminal* failure, not a capacity wait).

---

## 1. Deploy the watcher

Lagotto runs as a serverless poller **in your own account**. Stand it up once:

```sh
lagotto deploy
lagotto setup
```

`deploy` creates the poller Lambda, its EventBridge schedule and an SNS alerts
topic with direct AWS API calls. The schedule deploys **disabled**: your first
watch arms it, and the poller disables it again when no watches remain.

`setup` is the step that's easy to miss. `deploy` gives the poller only a minimal
role, and **until you run `setup` it can only notify**, so a watch with
`--action spawn` (step 3) can't launch anything. If your spawn config names an
instance role (`iam_role`), authorize it too, with
`lagotto setup --instance-role <name>`. `lagotto doctor` checks the deployment
read-only.

---

## 2. Create a notify-only watch

Start conservatively: watch three regions, check every five minutes, and just
**tell me** when capacity appears — don't launch anything yet.

```sh
lagotto watch "p5.48xlarge" \
  --regions us-east-1,us-west-2,us-east-2 \
  --action notify \
  --notify email:you@example.com \
  --ttl 7d
```

- `--action notify` — alert only; nothing launches
- `--ttl 7d` — give up after a week if capacity never appears (the TTL is the only
  time limit; there's no max-retry count)

Confirm it's active:

```sh
lagotto list
lagotto status <watch-id>
```

Lagotto now polls every ~5 minutes. When it finds capacity, you get an email and
the watch is marked `matched`.

---

## 3. Upgrade it to launch automatically

Once you trust the watch, replace "notify me" with "launch it for me." Write a
spawn config describing the instance you want, with a TTL so the launched instance
still self-terminates:

```yaml
# gpu-job.yaml
name: training
instance_type: p5.48xlarge
ttl: 6h
on_complete: terminate
command: ./run-training.sh && spored complete --status success
```

Then create the auto-launch watch:

```sh
lagotto watch "p5.48xlarge" \
  --regions us-east-1,us-west-2,us-east-2 \
  --action spawn \
  --spawn-config gpu-job.yaml \
  --notify email:you@example.com \
  --ttl 7d
```

Now when capacity appears, Lagotto launches the instance with a 6-hour TTL, runs
your job, and the instance terminates on completion — the whole chain fires with
no one awake to run it.

::: tip The launch attempt *is* the capacity test
There's no AWS API that reports "capacity is available now." For a `spawn` watch,
Lagotto's launch attempt is the real test: if AWS returns
`InsufficientInstanceCapacity` the watch stays `active` and retries next poll. A
*terminal* error (bad AMI, exhausted quota) marks the watch `failed` instead of
retrying forever.
:::

---

## 4. Clean up

A watch ends on its own when it matches, fails, or its TTL expires. To stop one
early:

```sh
lagotto cancel <watch-id>
```

When no watches remain, the poller disables its own schedule automatically. To
remove the poller (the Lambda, schedule and topic):

```sh
lagotto deploy --teardown
lagotto teardown          # and, separately, the DynamoDB tables
```

---

## What just happened

You turned "keep manually re-trying a launch for a scarce GPU" into a
fire-and-forget watch running in your own account. Lagotto did the tedious
retrying, respected your quota, and — in the auto-launch version — handed off to
spawn, which launched an instance that manages its own lifecycle via
[spored](/tools/spored).

## Next steps

- **[Lagotto](/tools/lagotto)** — every action, SageMaker watches, and Capacity Blocks for ML
- **[Scheduled launches](/tools/lagotto#lagotto-launch)** — launch by clock time (e.g. into a Capacity Block)
- **[GPU Training Jobs](/guides/gpu-training)** — what to run once you have the instance
