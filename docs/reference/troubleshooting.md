---
description: "The distinctions that trip people up — find vs search, TTL vs idle, quota vs capacity — and how to get them right."
---

# Troubleshooting & common mistakes

Most spore.host surprises come from a handful of pairs that look interchangeable
but aren't. Each entry below is a mistake, why it happens, and the fix.

## `truffle find` vs `truffle search`

**Mistake:** expecting `--min-vcpu`/`--min-memory` to work on `find`, or expecting
`find` and `search` to be synonyms.

- **`find`** is *natural-language discovery* — put specs **in the query string**:
  `truffle find "epyc genoa 16 cores"`. It does **not** accept `--min-vcpu` etc.
- **`search`** is *exact filtering* over a pattern — flags work here:
  `truffle search "m8a.*" --min-vcpu 16 --min-memory 64`.

Use `find` when you know what you need in human terms; use `search` when you know
the exact technical filters. See [Truffle](/tools/truffle).

## Region vs Availability Zone

**Mistake:** treating a region and an AZ as the same scope. Capacity, and some
launches (Capacity Blocks), are **AZ-specific**. A type available in `us-east-1`
generally may still be unplaceable in `us-east-1a`. Use `truffle az` to inspect
per-AZ offerings and pass `--az` when placement must be pinned.

## Quota vs actual capacity

**Mistake:** assuming that because `truffle quotas` shows headroom, AWS will place
the instance. Quota is *permission* to launch; capacity is *availability right
now*. They're independent — you can be within quota and still get
`InsufficientInstanceCapacity`. That's exactly the gap [Lagotto](/tools/lagotto)
fills. See [Waiting for scarce capacity](/guides/waiting-for-capacity).

## stop vs hibernate vs terminate

| Action | Compute billing | EBS kept | RAM preserved | Reversible |
|--------|-----------------|----------|---------------|-----------|
| **stop** | stops | yes | no | `spawn start` |
| **hibernate** | stops | yes | yes (restored on start) | `spawn start` |
| **terminate** | stops | **no** — volume destroyed | no | no |

**Mistake:** `terminate` to "pause" a job — it destroys the EBS volume and its
data. Use `stop`/`hibernate` to pause; `terminate` only when you're done.

## TTL vs idle timeout

**Mistake:** thinking either one alone will save you. **TTL** is the absolute,
non-resettable deadline (the hard guarantee; a `--cost-limit` and
`--on-complete terminate` can also terminate earlier). **Idle timeout** is a soft early
stop that any activity resets. On an ordinary launch it never *terminates*, only
stops or hibernates; the exceptions are `spawn service` instances, pool workers and
`spawn burst` members, which terminate at their idle timeout. You typically want both. See [Costs & safety guarantees](/safety).

## Spot interruption vs idle shutdown

**Mistake:** conflating the two. A **Spot interruption** is AWS reclaiming the
instance (a 2-minute notice, outside your control); **idle shutdown** is spored
stopping an instance *you* left inactive. Different triggers, different handling —
set a `pre-stop` hook to save work for both.

## Restarting a stopped instance whose TTL already passed

**Mistake:** stopping an instance to "bank" its remaining time. The TTL is an
*absolute* deadline — if it elapsed while the instance was stopped, starting it
again will terminate it shortly after. Run `spawn extend` **before** starting if
you need more time.

## A command finishing vs the completion sentinel appearing

**Mistake:** expecting `on-complete` to fire when work you started by hand exits.
spored acts on the **completion sentinel** (`/tmp/SPAWN_COMPLETE`, or the path
given with `--completion-file`), not on a process exiting.

A `--command` is the exception that isn't one: when it exits, **pass or fail**,
spawn's wrapper records the exit code in `/tmp/SPAWN_EXITCODE` and writes the
sentinel for you (since v0.113.0), so `--on-complete` fires either way. It writes
the `--completion-file` path when you set one, and so does `--mpi-command` on every
member (since v0.135.2; older versions always wrote `/tmp/SPAWN_COMPLETE`, so a
custom path never fired). A failed
command does **not** leave the instance up until the TTL. If you want a failed
instance kept for inspection, use `--on-complete stop` (or omit `--on-complete`);
otherwise read the failure afterwards with `spawn logs <name>`
([Logs and debugging](/guides/logs)).

Work you start some other way (over `spawn connect`, from a plugin, a service you
run yourself) has to create the sentinel when it's done:

```sh
./run-job.sh; spored complete --status success
```

## "spored never came up" vs "spored could not be verified" {#spored-never-came-up}

After a launch, spawn waits for spored's `spawn:last-heartbeat` tag, which it
reads with `ec2:DescribeInstances`, and asks SSM as a second signal. The two
failures mean different things:

- **`spored never came up`**: no heartbeat and no SSM answer within 5 minutes
  (10 on Windows). The instance is running but nothing on it enforces the TTL,
  idle timeout or cost limit. The message says what was missing, for example
  that the SSM agent never registered either, and points at the boot log
  (`spawn logs <instance-id> --console`). Terminate the instance, or relaunch
  with `--terminate-on-error` to have spawn do it.
- **`spored could not be verified`**: your credentials were refused
  `ec2:DescribeInstances`, so spawn couldn't look. It says nothing about the
  instance, which may be fine. Check it with `spawn status <id>`, and add the
  action from [IAM Permissions](/reference/iam-permissions).

A refused SSM call is named in the message, as
`your credentials lack ssm:DescribeInstanceInformation`, and doesn't fail the
launch on its own. Before spawn v0.136.0, verification used only SSM: an AMI
without the SSM agent (official Rocky and RHEL images), or a caller without the
SSM permissions, waited out the timeout and was told spored never came up.

## Instance role vs your user credentials

**Mistake:** assuming a launched instance inherits your laptop's AWS permissions.
It doesn't — it uses its **instance profile** (IAM role). If spored can't manage
the instance (e.g. call `ec2:TerminateInstances` on itself) or your job can't
reach S3, the instance profile is usually the missing piece. See
[IAM Permissions](/reference/iam-permissions).

## Local CLI vs remote spored timing

**Mistake:** expecting a tag or config change to take effect instantly. Some
actions are immediate API calls from spawn; others (idle, TTL, completion) are
enforced by **spored, which re-reads the instance's tags about once a minute**. A
`spawn instance-config` change can take up to a minute to be observed on the
instance. Use `spored reload` on the instance to force an immediate re-read.

## Still stuck?

- **[FAQ](/reference/faq)** — higher-level questions
- **[Glossary](/reference/glossary)** — precise definitions
- **[Lifecycle Events](/reference/lifecycle-events)** — what warnings fire and when
- Logs on the instance: `journalctl -u spored -f`
