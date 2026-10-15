---
description: "The auto-terminate promise, its failure boundaries, and how to estimate what a run will cost before you launch."
---

# Costs & safety guarantees

The core promise of spore.host is consequential: **every instance manages its own
lifecycle and stops when it should**. This page states exactly what that guarantee
covers, where it can fail, how the failure is caught, and how to estimate the cost
of a run *before* you launch it.

## The guarantee, precisely

Three independent rules can end an instance's life, in strict priority:

| Rule | What it is | Can it be reset? |
|------|-----------|------------------|
| **TTL** | An absolute deadline set once at launch. | **No.** It never moves across stop/wake cycles. Only `spawn extend` changes it, and only forward. |
| **Cost limit** | Terminate when accumulated **compute + EBS** spend crosses a ceiling. | Set at launch; never resets — compute accumulates across stop/resume, and EBS accrues on wall-clock time, including while stopped. |
| **Idle timeout** | Stop or hibernate after a period of no activity. | Yes — any activity resets the timer. Idle **never terminates**; it only stops/hibernates. |

The key invariant: **TTL always wins.** Idle detection is a soft, early
cost-saver; the TTL is the hard backstop that guarantees the instance dies even if
idle detection is misconfigured, disabled, or fooled by a busy-looping process.

::: tip Restarting a stopped instance whose TTL already passed
Because the TTL is an absolute deadline, a stopped instance whose deadline elapsed
while it was stopped will terminate shortly after you start it again — starting it
does not grant fresh time. Use `spawn extend` first if you need more.
:::

## Where it can fail — and the backstop

spored enforces the lifecycle from inside the instance. That's robust (it survives
your laptop closing), but it means the guarantee has boundaries. Here's each
failure mode and what catches it:

| If… | …then | Caught by |
|-----|-------|-----------|
| spored fails to install at launch | the instance may not self-manage | spawn reports provisioning failure; the **reaper** still enforces TTL from the tags |
| the instance can't reach AWS APIs | spored can't update cost tags or send events | TTL still fires locally; reaper is the backstop |
| the instance profile / IAM role is missing | spored can't call `ec2:TerminateInstances` on itself | the out-of-band **reaper** terminates it |
| the tags are changed or removed | lifecycle rules are lost | reaper flags instances missing required `spawn:*` tags |
| the spored daemon crashes | no in-instance enforcement | reaper enforces the deadline from the tags |

The **reaper** is an out-of-band backstop that reads the same `spawn:ttl-deadline`
tag and terminates any managed instance past its deadline, independent of whether
spored is healthy. This is why lifecycle enforcement doesn't depend on a single
point of failure: the instance enforces its own deadline *and* an external sweep
enforces it too.

## What the guarantee is by deployment mode

Whether you get one enforcement layer or two depends on which mode you deploy. The
reaper is **not enabled by default** — the plain CLI gives you in-instance
enforcement only, and the backstop is something you opt into.

| Mode | spored (in-instance) | Out-of-band reaper | Workload data leaves your account | Failure guarantee |
|------|:---:|:---:|:---:|---|
| **CLI only** (default) | Yes | No | No | spored terminates at TTL from inside the instance. If spored is disabled or killed, only your AWS-side controls (Budgets / SCPs) remain. |
| **Self-hosted backstop** | Yes | Yes (in your account) | No | Dual enforcement — the reaper terminates past-deadline instances even if spored fails. |
| **Hosted integrations** | Yes | Yes / optional | Selected metadata only (never credentials or workload data) | Dual enforcement when the reaper is enabled. |

The reaper (see
[spawn/lambda/ttl-reaper](https://github.com/spore-host/spawn/tree/main/lambda/ttl-reaper))
ships in **dry-run** — it logs "would reap" and notifies but does not terminate —
until an operator flips it to enforce mode after verification. It assumes a narrow
per-account [cross-account role you grant](/architecture),
scoped to terminating past-deadline `spawn:managed` instances, and never holds your
credentials. The full guarantee-by-mode breakdown lives in
[SECURITY.md](https://github.com/spore-host/spore-host/blob/main/SECURITY.md#lifecycle-guarantee-by-deployment-mode).

## Verify enforcement is healthy

Don't take it on faith — confirm it, especially the first few times:

```sh
# From your laptop: TTL countdown proves the deadline tag is set and live
spawn status my-instance

# On the instance (over SSH): the enforcing daemon is up
sudo systemctl status spored     # want: active (running)
spored status                    # shows TTL, idle, cost, pre-stop hook
```

To find instances that are **not** being managed correctly — no `spawn:*` tags, or
missing a deadline — audit with `spawn list` and the tag query in
[Security, credentials & data flow](/architecture#how-to-audit-everything-it-creates).

## Estimating cost before you launch

The safety promise is ultimately about money. You can bound the worst case up
front, because the TTL caps compute time and truffle knows the rate.

**Worked example — an 8-hour analysis box:**

```sh
truffle spot m8a.4xlarge --regions us-east-1   # get the rate
spawn launch analysis --instance-type m8a.4xlarge --ttl 8h --idle-timeout 30m
```

| Quantity | Value |
|----------|-------|
| Instance | `m8a.4xlarge` |
| On-demand rate | ~$0.77/hr (example — check `truffle spot`) |
| TTL | 8h |
| **Maximum compute charge** (before storage/network) | **8 × $0.77 ≈ $6.16** |
| Idle timeout | 30m |
| Likely charge if work finishes in ~2h | ~2.5h × $0.77 ≈ **$1.93** |

The TTL is the ceiling you *cannot* exceed; the idle timeout is what usually stops
you well below it. Storage (EBS) and data transfer are billed separately and are
typically small next to compute for short runs — see `spawn cost` for the running
breakdown once an instance is live:

```sh
spawn cost analysis        # compute + storage + network, effective rate, budget status
```

Set a hard money ceiling with `--cost-limit` at launch if you want spend, not just
time, to be the terminating rule. It's a **total** ceiling over the spend that
ends with the instance:

- **Compute** — instance rate × total compute time, accumulated across
  stop/resume (it doesn't reset when you restart).
- **EBS** — the instance's volumes × wall-clock time since launch. Volumes bill
  while the instance is stopped, so a stopped instance keeps moving toward its
  cap. (Counted once spored has looked up the volumes' rate on first boot.)

It warns at 90% and **terminates** the instance when crossed, which also ends the
EBS bill (spawn's volumes are deleted on termination). It fires independently of
the TTL — whichever ceiling is reached first ends the instance.

Storage that *outlives* the instance can't be bounded this way: terminating
wouldn't stop it billing. So an FSx filesystem created with `--fsx-create` isn't
counted in flight — instead `spawn launch` refuses up front when the filesystem's
monthly cost alone exceeds `--cost-limit` (override with
`--allow-cost-limit-overrun`). Data transfer, and storage you attach that spawn
didn't create, are not covered.

## Next steps

- **[Security, credentials & data flow](/architecture)** — what runs where
- **[Spored](/tools/spored)** — the daemon that enforces all of this
- **[Lifecycle Events](/reference/lifecycle-events)** — the warnings you get before anything stops
