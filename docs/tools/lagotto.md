---
description: "Lagotto watches for EC2 instance capacity and acts when it appears."
---

# Lagotto <span class="doc-badge advanced">Advanced</span> <span class="doc-badge stable">Stable</span>

**What it is.** Lagotto watches for EC2 instance capacity and acts when it appears.
It runs as a serverless Lambda in **your own account** — no always-on server.

**When to use it.** When the type you want is within quota but has no capacity
*right now* (scarce GPU families like `p5.48xlarge`), or when you need a launch to
fire at a future clock time (e.g. into a Capacity Block). Answers the question
truffle and a one-shot spawn can't: *"should I keep checking until it's placeable?"*

**First commands:**

```sh
lagotto deploy                                   # stand up the watcher (once)
lagotto watch "p5.48xlarge" --regions us-east-1,us-west-2 --action notify --ttl 7d
lagotto list                                     # see active watches
lagotto status <watch-id>
```

New to it? Walk through [Waiting for scarce capacity](/guides/waiting-for-capacity).

There is no AWS API that reports "capacity is available right now" — the only true test is an actual launch. So for `spawn` watches **the launch attempt is the capacity test**: Lagotto tries to launch, and if AWS returns `InsufficientInstanceCapacity` it simply keeps the watch active and tries again on the next poll. It does the tedious retrying for you instead of you sitting there re-running a launch by hand, until it succeeds or the watch's TTL expires.

## Install

```sh
brew install spore-host/tap/lagotto
```

## The problem it solves

Some instance types — particularly high-demand GPU families like p5.48xlarge or trn1.32xlarge — have intermittent availability. You want the instance, but there's none available right now. Without Lagotto, your options are: keep trying manually, or write your own polling loop.

Lagotto automates the waiting.

## Core commands

### `lagotto watch`

Create a watch for an instance type pattern in one or more regions:

```sh
# Watch for any p5 instance and notify when available
lagotto watch "p5.*" --ttl 7d

# Limit to specific regions
lagotto watch "p5.48xlarge" --regions us-east-1,us-west-2

# Watch and notify via email or webhook
lagotto watch "p5.48xlarge" --action notify \
  --notify email:you@example.com

# Watch and auto-launch when capacity appears
lagotto watch "g5.xlarge" --action spawn \
  --spawn-config my-job.yaml

# Watch for Spot capacity under a price ceiling
lagotto watch "p4d.24xlarge" --spot --max-price 10.00

# Keep submitting a SageMaker training job until SageMaker has capacity for it
lagotto watch "ml.g5.2xlarge" --service sagemaker --action spawn \
  --sagemaker-config train-job.json \
  --notify email:you@example.com
```

The `--spawn-config` file uses lagotto's own schema. It is not the file
`spawn launch --config` reads (that holds only a `plugins:` list), and not a sweep
`--param-file`. See [Launch config files](/reference/launch-config-files#lagotto-spawn-config)
for every key, and for which `spawn launch` flags have no key (`--az` is
`lagotto watch --azs`, for example).

#### Watching SageMaker capacity (`--service sagemaker`)

SageMaker Training/Processing jobs can fail with `CapacityError` even when your
quota is sufficient. AWS exposes **no** read-only SageMaker capacity API, and
SageMaker draws on its own managed pool, so EC2 availability says nothing useful
about it. The only real test is submitting the job.

So with `--service sagemaker --action spawn`, lagotto **submits your job
itself**, from the definition in `--sagemaker-config <file.json>` (the
`CreateTrainingJobInput` document, validated by SageMaker at submit). It then
polls the job: a running or `Completed` job records a match, and a
`CapacityError` leaves the watch active to try again on the next cycle. A
capacity-blocked job becomes fire-and-forget.

::: warning Use `--action spawn` for SageMaker
The default action is `notify`. With `--service sagemaker`, a notify watch
neither submits the job nor sends anything: with no capacity signal, there's
nothing to notify on ([lagotto#195](https://github.com/spore-host/lagotto/issues/195)).
`--sagemaker-config` is also ignored unless the action is `spawn`.
`--action hold` is rejected for SageMaker, since there's no capacity-reservation
equivalent.
:::

### `lagotto list`

```sh
lagotto list              # active watches only
lagotto list --all        # include matched, failed, expired, and cancelled
lagotto list --output json
```

### `lagotto status`

```sh
lagotto status <watch-id>
```

### `lagotto cancel`

```sh
lagotto cancel <watch-id>
```

Cancels an active watch. From lagotto v0.65.0 it also releases the capacity
reservation of a `--action hold` watch that already fired; see
[Releasing a hold early](#releasing-a-hold-early).

### `lagotto extend`

```sh
lagotto extend <watch-id> --ttl 48h
```

### `lagotto history`

```sh
lagotto history                        # all your matches
lagotto history --watch-id <watch-id>  # one watch
```

### `lagotto poll`

Manually trigger one polling cycle (useful for testing), or loop in the foreground with `--daemon`:

```sh
lagotto poll                                 # one cycle
lagotto poll --daemon --interval 5m          # loop, infra-free (no Lambda needed)
```

In a **shared account**, scope a daemon to your own watches so it doesn't drive another project's:

```sh
lagotto poll --daemon --project fieldwork    # only that project (or $LAGOTTO_PROJECT)
lagotto poll --daemon --mine                 # only watches you created
lagotto poll --daemon --watch w-aaa,w-bbb    # only these watch IDs
```

A scoped daemon exits when **its** watches drain. Before acting on a match a poller claims a short **lease** on the watch, so two daemons — or a daemon racing the hosted Lambda — can't both launch it (`--no-lease` opts out). Tag a watch for scoping with `lagotto watch --project NAME` (or `$LAGOTTO_PROJECT`).

### `lagotto launch`

Schedule a launch by **time** rather than capacity — fire once at a clock time (`--at`), after a delay (`--after`), or on a recurring cron (`--cron`):

```sh
# Launch into a Capacity Block at its reserved start time
lagotto launch --at 2026-07-01T08:00:00Z --az us-east-1a --spawn-config block.yaml

# Launch 6 hours from now
lagotto launch --after 6h --spawn-config job.yaml

# Recurring: every weekday at 09:00 UTC
lagotto launch --cron "0 9 ? * MON-FRI *" --spawn-config nightly.yaml
```

The motivating case is launching into an **EC2 Capacity Block for ML** at its reserved start time — see [Capacity Blocks](#capacity-blocks-for-ml) below. Scheduled launches run on EventBridge Scheduler in the hosted poller stack, so they require `lagotto deploy` first; the launched instance always carries a TTL. If an instance with the same `Name` tag already exists at fire time, `--if-exists skip|launch|replace` decides what happens (default: `skip` for one-shots so a Capacity Block can't double-book, `launch` for cron).

## Actions

When a watch matches, Lagotto can:

| Action | What happens |
|--------|-------------|
| `notify` | Sends a notification via `--notify` channels (email, webhook, SNS) |
| `spawn` | Launches an instance using the config file given in `--spawn-config` |
| `hold` | Creates a 30-minute, targeted On-Demand Capacity Reservation for one instance in the matched AZ. It bills from creation; see [Holding capacity](#holding-capacity-action-hold) |

SageMaker watches (`--service sagemaker`) support `notify` (alert only) or `spawn`
— for SageMaker, `spawn` **submits your training job** via
`--sagemaker-config` rather than launching an EC2 instance. `hold` is not
supported (no capacity-reservation equivalent).

## Holding capacity (`--action hold`)

A `hold` watch doesn't launch anything. When it matches, it reserves the capacity
for you to launch into yourself.

```sh
lagotto watch "g6e.12xlarge" --regions us-east-1,us-west-2 \
  --action hold --notify email:you@example.com --ttl 2d
```

**What it creates.** One EC2 On-Demand Capacity Reservation with:

- instance count **1**, of the matched instance type;
- platform **Linux/UNIX**;
- the **matched availability zone**;
- **targeted** matching: only a launch that names the reservation uses it;
- an end date **30 minutes** after it was created. EC2 ends it then.

The 30 minutes is fixed; there is no flag to change it. The reservation is tagged
`lagotto:watch-id` and `lagotto:managed=true`.

::: warning A hold bills from the moment it's created
An unused reservation bills at the On-Demand rate. **The worst case is 30
minutes of the On-Demand price for one instance of the matched type**, whether
you launch into it or not. An instance you launch into the reservation is billed
against it, not on top of it. When the 30 minutes end, an instance you launched
keeps running as an ordinary On-Demand instance, under its own TTL.
:::

A hold is not a cheap "is capacity available?" probe. EC2 admits a reservation
more strictly than a launch, so a hold can fail with
`InsufficientInstanceCapacity` (and the watch keeps retrying) for a type that
`--action spawn` would launch at once. Use `hold` only when you want the
capacity reserved for you.

### Getting the reservation id

The reservation is targeted, so you need its id (`cr-…`) and AZ to use it.

- **`lagotto status <watch-id>`.** From lagotto v0.65.0 the table shows it under
  "Last match":

  ```text
  Last match:
    Instance: g6e.12xlarge
    Region:   us-west-2
    AZ:       us-west-2b
    ...
    Action:   held
    Reservation: cr-0123456789abcdef0 (us-west-2b)
    Release it early with: lagotto cancel w-abc123
  ```

  `lagotto status <watch-id> -o json` has it as `last_match.reservation_id`,
  with the AZ in `last_match.availability_zone`. This works in every version;
  before v0.65.0 the JSON is the only place `status` shows it.
- **Notifications.** A hold sends to the watch's `--notify` channels. From
  lagotto v0.65.0:
  - the **email** names the reservation and its AZ, and gives the
    `spawn launch` and `lagotto cancel` commands;
  - **SNS** and **webhook** payloads carry `reservation_id` and
    `reservation_availability_zone`, next to `instance_type`, `region` and
    `availability_zone`.

  The hosted poller sends these fields once its Lambda is v0.65.0 or later:
  re-run `lagotto deploy` with a v0.65.0 CLI, since `--version` defaults to the
  CLI's own version.

### Launching into it

Give the instance a name, and name the reservation, its AZ and the matched
instance type (spawn doesn't read the type or AZ from the reservation):

```sh
spawn launch held-job --region us-west-2 --az us-west-2b \
  --instance-type g6e.12xlarge \
  --reservation-id cr-0123456789abcdef0 \
  --ttl 8h
```

The instance type and platform must match the reservation (Linux/UNIX, the type
the watch matched). Launch within the 30 minutes.

::: warning A hold can land in a Local Zone
lagotto doesn't skip Local Zones. If your account has opted in to one, a hold can
be created there (for example `us-west-2-lax-1b`), even when the watch names only
regions. A default VPC has no subnet in a Local Zone, so the `spawn launch` above
fails until you create one. To keep holds in ordinary zones, pass
`--azs` to `lagotto watch`
([lagotto#209](https://github.com/spore-host/lagotto/issues/209)).
:::

### Releasing a hold early

If you won't use the reservation, release it so it stops billing:

```sh
lagotto cancel <watch-id>
```

From lagotto v0.65.0, `cancel` on a hold that already fired (status `matched`)
releases the reservation. The watch stays `matched`. Releasing one that already
expired or was already released reports that and succeeds, so running it twice
is safe. On an `active` watch, `cancel` cancels the watch and releases any
reservation it recorded.

`cancel` runs with **your own** AWS credentials, not the poller's, so they need:

- `ec2:CancelCapacityReservation`
- `ec2:DescribeCapacityReservations` (used to tell whether a reservation that
  can't be cancelled had already ended)

Without `ec2:CancelCapacityReservation`, `cancel` says so and reports when the
reservation will expire on its own. lagotto doesn't create this grant for you
yet ([lagotto#206](https://github.com/spore-host/lagotto/issues/206)).

lagotto v0.64.1 and earlier refuse to cancel a `matched` watch. There, release
the reservation with the EC2 CLI, or let it expire at the end of its 30 minutes:

```sh
aws ec2 cancel-capacity-reservation --region us-west-2 \
  --capacity-reservation-id cr-0123456789abcdef0
```

## Watch lifecycle

A watch is `active` while it's being polled, and ends in one of:

| Status | Meaning |
|--------|---------|
| `matched` | The action succeeded (notified, launched, or held) |
| `failed` | A launch hit a **terminal** error that retrying can't fix (bad AMI/IAM, exhausted quota) |
| `expired` | The watch TTL elapsed before it could act |
| `cancelled` | You cancelled it with `lagotto cancel` |

The watch **TTL is the only time limit** — there is no max-retry count. A
capacity failure (`InsufficientInstanceCapacity`) is *not* terminal: the watch
stays `active` and retries on the next poll until it launches or the TTL runs out.

## How it works

Lagotto deploys as an AWS Lambda function with an EventBridge schedule trigger.
Each tick (default 5 minutes) it pre-filters with `DescribeInstanceTypeOfferings`
and spot pricing to decide which watches are worth acting on — but those are only
hints, not capacity guarantees. For a `spawn` watch the actual launch is the real
test: a capacity failure keeps the watch active to retry, while a terminal failure
marks it `failed`.

The poller is a **self-terminating, per-account singleton**: there is one Lambda
+ schedule per account, every invocation sweeps all active watches, and watches
drop out of the active set as they launch, fail, or expire. When **zero** active
watches remain, the Lambda disables its own schedule — no watches, no Lambda.
Creating a new watch re-arms it.

## Capacity Blocks for ML

Lagotto is the last step of the end-to-end Capacity Block flow across the three tools:

1. **Discover** a purchasable offering — `truffle capacity-blocks --instance-type p5.48xlarge --count 1 --duration-hours 24` (read-only).
2. **Purchase** it — `spawn capacity-block purchase <offering-id> ...` (billed up front, non-refundable; three typed confirmations, interactive-only).
3. **Launch into it at the reserved start time** — `lagotto launch --at <block-start> --az <block-az> --spawn-config block.yaml`, where `block.yaml` sets `reservation_id` + `capacity_block: true` (forwarded to `spawn launch --reservation-id … --capacity-block`).

Step 3 is why `lagotto launch --at` exists: the block becomes usable at its start time, and a scheduled launch brings the instance up automatically — no one awake at 08:00 to run it.

## Deploy

Deploy the hosted poller stack **into your own account** with one command:

```sh
lagotto deploy                 # stand up Lambda + EventBridge + DynamoDB + IAM
lagotto deploy --teardown      # remove it
```

`lagotto deploy` downloads the published poller Lambda artifact, uploads it to a bucket in your account, and creates the poller with direct AWS API calls: the SNS alerts topic, the Lambda and its EventBridge schedule. CloudFormation is no longer used. The schedule deploys disabled; the first `lagotto watch` enables it, and the poller disables its own schedule when no watches or pending scheduled launches remain. The Lambda and topic stay until `lagotto deploy --teardown`.

**Then run `lagotto setup`.** `deploy` gives the poller only a minimal role, so it can't grant itself anything. Until you run `setup`, which attaches the policy to spawn, hold and submit SageMaker jobs, the poller can only notify. If a watch's spawn config names an instance role (`iam_role`), also authorize it with `lagotto setup --instance-role <name>`; otherwise the watch matches, then fails at launch with AccessDenied.

```sh
lagotto deploy
lagotto setup
lagotto doctor        # read-only check of the deployment
```

See the [deployment guide](https://github.com/spore-host/lagotto/blob/main/DEPLOYMENT.md) for the details, and the optional CloudFormation template for infrastructure-as-code setups. Once deployed, the `lagotto` CLI manages watches and scheduled launches in that infrastructure.

## Full command reference

→ [lagotto command reference](/tools/reference/lagotto)
