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
- Or: a watch that **keeps hunting until the launch lands**, with no TTL, and
  checks in with you instead (lagotto v0.68.0 and later)

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
- `--ttl 7d` — give up after a week if capacity never appears. There's no
  max-retry count: a TTL watch stops at its TTL, and step 4 shows a watch with
  no TTL at all

::: warning notify means "offered", not "launchable"
A notify watch fires when the type is *offered* in a region or AZ. That doesn't
mean a launch would succeed. A scarce type like `p5.48xlarge` is offered almost
everywhere, so this watch can fire on its first poll while a real launch still
gets `InsufficientInstanceCapacity`. To wait for capacity you can actually use,
let the watch try the launch: `--action spawn` (step 3) or `--action hold`.
:::

Confirm it's active:

```sh
lagotto list
lagotto status <watch-id>
```

Lagotto now polls every ~5 minutes. When it finds the type offered, you get an
email and the watch is marked `matched`.

The first email needs confirming (lagotto v0.67.0 and later): `watch` subscribes the address, and AWS sends
an "AWS Notification - Subscription Confirmation" email. Nothing is delivered
until you click its link.

---

## 3. Upgrade it to launch automatically

Once you trust the watch, replace "notify me" with "launch it for me." Write a
spawn-config file describing the instance you want, with a TTL so the launched
instance still self-terminates. This is lagotto's own format, not the file
`spawn launch --config` reads; [Launch config files](/reference/launch-config-files#lagotto-spawn-config)
lists every key and the `spawn launch` flag each one matches:

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
no one awake to run it. From lagotto v0.67.0 the watch is `matched` only once the
instance is actually `running`; if EC2 terminates it while it's still `pending`, the watch goes back to
hunting.

From lagotto v0.68.0, `lagotto watch` prints what the watch can cost if it lands,
for example `Exposure: if this lands: up to $X/hr (≈$Y/day)`, and
`lagotto status` and the `EXPOSURE` column of `lagotto list` show the same. The
rate is your `--max-price`
when you set one, otherwise the on-demand rate from spore.host's static price
list, labelled with the date that list was collected. The static list has no GPU
family newer than p4d, so for `p5.48xlarge` the line says `unknown`.

`watch` also checks the regions' **default subnets** (lagotto v0.68.0 and
later). The poller launches into the default VPC without naming a subnet, so it
can only land in an AZ that has a default subnet. If none of the AZs that offer
the type has one, `watch` refuses and prints the
`aws ec2 create-default-subnet --region ... --availability-zone ...` command;
if only some lack one, it warns about each.

The watch, not the file, decides the instance type, region, zone and Spot: the
matched values replace `instance_type`, `region` and `spot`. To restrict zones,
pass `--azs` to `lagotto watch`; there is no `az:` key.

::: tip The launch attempt *is* the capacity test
There's no AWS API that reports "capacity is available now." For a `spawn` watch,
Lagotto's launch attempt is the real test: if AWS returns
`InsufficientInstanceCapacity` the watch stays `active` and retries next poll. A
*terminal* error (bad AMI, exhausted quota) marks the watch `failed` instead of
retrying forever.
:::

---

## 4. Or: keep hunting until it lands

A TTL makes you guess how long capacity will take. For a long hunt, lagotto
v0.68.0 and later can instead keep going until the launch actually lands, with
no TTL:

```sh
lagotto watch "p5.48xlarge" \
  --regions us-east-1,us-west-2,us-east-2 \
  --action spawn \
  --spawn-config gpu-job.yaml \
  --notify email:you@example.com \
  --until-landed
```

`watch` shows what the watch can cost if it lands and asks you to confirm (pass
`--yes` in a script). It needs a `--notify` channel. It works with
`--action spawn` and `--action hold`, but not with `--action notify` (an
offering isn't a landing), `--ttl`, `--maintain` or `--until`.

So that a forgotten watch can't hunt forever, it has an **acknowledgement
deadline** instead of a TTL, a dead-man's switch:

- The deadline is 3 × `--remind` (default `7d`, so 21 days) after you create the
  watch or last acknowledge it. `--remind` can be `1h` to `30d`.
- The poller **reminds you** on your `--notify` channels on day 7 and day 14,
  and sends a final warning 24 hours before day 21. Each reminder says what the
  watch is hunting, how the hunt is going (attempts, last error, last poll), what
  it can cost, and the command that keeps it going:

  ```sh
  lagotto ack <watch-id>      # moves the deadline 21 days ahead from now
  ```

- If you don't acknowledge it, the watch **pauses**: `lagotto status` shows it
  `expired` with reason `unacknowledged`, and you get a "paused" notification.
  `lagotto ack` resumes it. Only `ack` and `extend` count; looking at it with
  `list` or `status` doesn't.

`lagotto list` shows the deadline as `until landed (ack in 4d)`, or
`paused (unacked)` once it has paused.

::: warning Reminders need an upgraded poller
The hosted poller sends the reminders, so they start only after you run
`lagotto deploy` with lagotto v0.68.0 or later. With an older poller the watch
still pauses at its deadline, just without reminding you first.
`lagotto watch --until-landed`, `lagotto ack` and `lagotto status` warn you when
the poller in your region is too old.
:::

### Change the search without starting over

If the hunt is going nowhere, widen it in place instead of cancelling and
re-creating the watch (lagotto v0.68.0 and later):

```sh
lagotto update <watch-id> --add-region eu-west-1 --add-type p5en.48xlarge --dry-run
lagotto update <watch-id> --add-region eu-west-1 --add-type p5en.48xlarge
```

The watch keeps its ID, attempts, history and confirmed email subscriptions, and
goes through the same checks as a new `watch`. `--dry-run` shows the
before/after diff without changing anything. You can't change the action or the
deadline with `update`; use `lagotto ack` or `lagotto extend` for the deadline.

---

## Or: hold the capacity and launch it yourself

`--action hold` is the third option. When capacity appears, Lagotto reserves it
instead of launching:

```sh
lagotto watch "p5.48xlarge" \
  --regions us-east-1,us-west-2,us-east-2 \
  --action hold \
  --notify email:you@example.com \
  --ttl 7d
```

The reservation is a targeted On-Demand Capacity Reservation for **one**
instance, Linux/UNIX, in the matched AZ, and it ends **30 minutes** after it's
created (fixed, not configurable). It bills at the On-Demand rate from the moment
it exists, so **the worst case is 30 minutes of On-Demand time for one instance,
used or not**.

Get the id and AZ from the notification or `lagotto status <watch-id>`, then
launch into it within the 30 minutes:

```sh
spawn launch held-job --region us-west-2 --az us-west-2b \
  --instance-type p5.48xlarge \
  --reservation-id cr-0123456789abcdef0 \
  --ttl 6h
```

If you won't use it, `lagotto cancel <watch-id>` releases it early (lagotto
v0.65.0 and later; it needs `ec2:CancelCapacityReservation` on your own
credentials). See [Holding capacity](/tools/lagotto#holding-capacity-action-hold)
for where the id appears in each version, the IAM, and a Local Zone caveat.

---

## 5. Clean up

A watch ends on its own when it matches, fails, or its TTL expires (an
`--until-landed` watch pauses at its acknowledgement deadline instead). To stop
one early:

```sh
lagotto cancel <watch-id>
```

For a hold that already fired, the same command releases the reservation
(lagotto v0.65.0 and later).

When no watches remain, the poller disables its own schedule automatically. To
remove everything lagotto created:

```sh
lagotto deploy --teardown       # this region's poller: schedule, Lambda, topic, artifact bucket
lagotto teardown                # the DynamoDB tables and any scheduled-launch schedules
lagotto teardown --iam-roles    # the two IAM roles, once no region runs a poller
```

Run `deploy --teardown` in each region you deployed to. From lagotto v0.68.0,
`deploy --teardown` also deletes the artifact bucket `lagotto deploy` created (a
bucket from an older deploy is tagged as lagotto's, and so deletable, by your
next `lagotto deploy`), and
`lagotto teardown` also deletes the `lagotto-scheduled-launches` table and the
per-launch `lagotto-launch-sl-*` schedules. Older versions left those behind.
`lagotto doctor` reports any that are left.

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
