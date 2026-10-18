---
description: "Spawn launches EC2 instances and manages their full lifecycle."
---

# Spawn <span class="doc-badge beginner">Beginner</span> <span class="doc-badge stable">Stable</span>

**What it is.** Spawn launches EC2 instances and manages their full lifecycle. It
provisions the [spored](/tools/spored) daemon onto each instance, which then
enforces auto-termination, idle detection, DNS, and notifications **independently
of your laptop**.

**When to use it.** Whenever you want to actually *run* something — from a single
scratch box to a production-scale sweep. Start with one machine; the same tool
scales up when you need it.

**First commands:**

```sh
spawn                                  # interactive wizard (no flags needed)
spawn launch analysis --instance-type m8a.4xlarge --ttl 8h
spawn connect analysis                 # SSH in
spawn status analysis                  # state, cost, TTL countdown
spawn terminate analysis               # tear it down
```

## Spawn vs spored — what runs where

Spawn is the **client** on your laptop; spored is the **agent** on the instance.
Some actions are immediate API calls from spawn; others happen later because
spored re-reads the instance's EC2 tags about once a minute.

```
Your computer                     AWS EC2 instance
  spawn  ── launch/provision ──▶   spored (reads spawn:* tags every ~1 min)
         ── extend / config ──▶      ├─ TTL, idle, completion, cost
                                     └─ stop / hibernate / terminate + notify
```

So `spawn extend` changes the deadline *immediately* (an API/tag write), but an
idle-timeout or completion action is enforced by spored on its next check. Full
picture: [Security, credentials & data flow](/architecture).

## The three tiers of spawn

Spawn is far more capable than "launch one instance." Learn it in tiers — you only
need Tier 1 to be productive:

**Tier 1 — One machine** <span class="doc-badge beginner">Beginner</span>
: `launch` → `connect` → run → `status` → `extend` → `stop`/`terminate`. Start at
[Your first instance](/guides/first-instance).

**Tier 2 — Managed workload** <span class="doc-badge automation">Automation</span>
: add `--command`, a completion signal, `--idle-timeout`, `--cost-limit`, and
lifecycle notifications so a job runs and cleans up unattended (Story B in [Common
Workflows](/guides/)).

**Tier 3 — Parallel & production scale** <span class="doc-badge advanced">Advanced</span> <span class="doc-badge hpc">HPC</span>
: [job arrays](/guides/job-arrays), [parameter sweeps](/guides/parameter-sweeps),
[MPI clusters](/guides/mpi), autoscaling, [workflow engines](/guides/workflow-engines),
images/snapshots, and Capacity Blocks. The [command reference](/tools/reference/spawn)
is the exhaustive map of this tier.

## Install

```sh
brew install spore-host/tap/spawn
```

## Core commands

### `spawn` / `spawn launch`

Launch an instance. With no arguments, the interactive wizard runs:

```sh
spawn
```

With flags:

```sh
spawn launch \
  --name my-instance \
  --instance-type g5.xlarge \
  --region us-east-1 \
  --ttl 8h
```

### `spawn list`

List your running (or all) instances:

```sh
spawn list
spawn list --state all
spawn list --region us-east-1
```

### `spawn status`

Detailed status for one instance:

```sh
spawn status my-instance
spawn status i-0a1b2c3d4e5f
spawn status my-instance -o json       # machine-readable
spawn status my-instance --check-complete   # exit 0=complete 1=failed 2=running 3=error
```

**`--check-complete`** polls the instance's completion file and exits with a
standardized code, so scripts can wait for a workload to finish (v0.36.6+):

| Exit | Meaning |
|------|---------|
| 0 | Complete — completion file present |
| 1 | Failed — completion file reports a failure status |
| 2 | Running — completion file not yet present |
| 3 | Error — instance unreachable or status undeterminable |

```sh
# Wait for a workload to finish
while spawn status my-job --check-complete; [ $? -eq 2 ]; do sleep 30; done
```

**JSON output** (`-o json`) has two shapes, depending on the instance state:

- **Running instance:** spawn asks spored on the instance (over SSH, or SSM when no
  key resolves) and prints `spored status --output json` verbatim. Top-level
  fields include `instance_id`, `name`, `region`, `spored_version`, `started_at`,
  `elapsed_seconds`, `compute_seconds`, `billed_seconds`, `stopped_seconds`,
  `cpu_percent`, `network_bytes_per_min`, `disk_bytes_per_min`, and these objects:
  `ttl` (`configured`, `remaining_seconds`, `terminate_at`), `idle`
  (`configured`, `timeout_seconds`, `is_idle`, `idle_seconds`, `action`,
  `remaining_seconds`), `on_complete` (`action`, `completion_file`,
  `sentinel_present`), and `cost` (omitted when no price is known).
- **Any other state** (stopped, pending, terminated, …): spawn builds the report
  from EC2 and the instance's tags without reaching the instance. It has
  `"source": "ec2"` and fields such as `instance_id`, `name`, `region`,
  `instance_type`, `spot`, `state`, `stopped_since`, `ttl_deadline`,
  `ttl_remaining_seconds`, `ttl_past_due`, `compute_seconds`, `compute_cost`,
  `storage_cost` and `cumulative_cost`.

Check for `"source": "ec2"` to tell the two apart.

### `spawn stop` / `spawn hibernate` / `spawn start`

```sh
spawn stop my-instance              # stop (compute billing pauses; EBS keeps billing)
spawn hibernate my-instance         # hibernate to disk (saves RAM state)
spawn start my-instance             # start stopped or hibernated instance
```

`stop` and `hibernate` preserve EBS volumes. To permanently destroy an instance, use `terminate`.

### `spawn terminate`

Permanently terminate an instance — destroys the instance and its EBS volumes
(unlike `stop`/`hibernate`). Irreversible, so it confirms by default:

```sh
spawn terminate my-instance              # prompts, then terminates
spawn terminate my-instance -y           # skip confirmation
spawn terminate --job-array-name workers # terminate a whole job array
```

### `spawn extend`

Push an instance's TTL deadline later. The duration is added to the current
deadline, not counted from now (if the deadline has already passed, the new one is
now plus the duration):

```sh
spawn extend my-instance 4h     # add 4 hours to the current deadline
```

### `spawn connect`

Open an interactive SSH session, or run a command and return. The command is wrapped in `bash -c` on the remote side, so compound operators and background jobs (`&`) work correctly:

```sh
spawn connect my-instance                                                        # interactive
spawn connect my-instance -- 'tail -20 /tmp/run.log'                            # one-shot
spawn connect my-instance -- 'cmd1 && cmd2'                                     # compound
spawn connect my-instance -- 'nohup bash /tmp/run.sh > /tmp/run.log 2>&1 &'    # background
spawn connect my-instance -- 'aws s3 cp s3://bucket/run.sh /tmp/ && bash /tmp/run.sh &'
```

When multiple instances share a name, `spawn connect` prefers the running one. Stopped or hibernated instances are automatically started before connecting — use `--no-start` to prevent this.

### `spawn defaults`

Manage default launch settings:

```sh
spawn defaults set slack-workspace T03NE3GTY
spawn defaults set idle-timeout 1h
spawn defaults set active-processes rsession
spawn defaults list
spawn defaults unset active-processes
```

Defaults are stored in `~/.spawn/config.yaml` and apply to every launch unless overridden. See [Configuration](/reference/configuration).

### `spawn notify`

Register instances and users for Slack, Teams, or Discord control:

```sh
spawn notify workspace add ...
spawn notify register ...
spawn notify enable ...
spawn notify list ...
```

See [Slack Setup](/guides/slack-setup), [Teams Setup](/guides/teams-setup) or [Discord Setup](/guides/discord-setup) for the full walkthrough.

### `spawn capacity-block purchase`

Purchase an EC2 Capacity Block for ML from an offering discovered with `truffle capacity-blocks`:

```sh
# Preview the price and terms (no charge)
spawn capacity-block purchase <offering-id> --instance-type p5.48xlarge \
  --count 1 --duration-hours 24 --region us-east-1 --dry-run

# Real purchase — prompts for three typed confirmations
spawn capacity-block purchase <offering-id> --instance-type p5.48xlarge \
  --count 1 --duration-hours 24 --region us-east-1
```

A Capacity Block is billed **up front** and is **non-refundable**, so the purchase requires three typed confirmations (the exact price, `purchase <offering-id>`, and an acknowledgement phrase) and refuses to run non-interactively — no `--yes` bypass. Once purchased, launch into it with `spawn launch --reservation-id <id> --capacity-block --az <block-az>`, or have lagotto launch it automatically at the reserved start time (`lagotto launch --at`). See [Capacity Blocks for ML](/tools/truffle#capacity-blocks-for-ml) for the full three-tool flow.

## Key concepts

**TTL** — every instance has an absolute termination deadline: `launch_time + TTL`. When it fires, the instance terminates. The deadline is stored in a tag at launch and is **never reset** by stop/wake cycles — it keeps counting even while the instance is stopped. `spawn extend` pushes the deadline forward, not from now.

**Idle timeout** — spored monitors CPU, network, disk, GPU, sessions, and configured process names. When all signals indicate inactivity for the configured duration, the instance **stops** (or hibernates with `--on-idle hibernate`). The idle timer **resets** every time the instance wakes. Idle timeout never terminates; the TTL, a `--cost-limit`, and `--on-complete terminate` do.

**Spored** — a small daemon that runs on the instance, enforces the TTL deadline, detects idleness, registers DNS, and sends lifecycle notifications. Installed automatically at launch.

**Pre-stop hooks** — a shell command that runs before any lifecycle-triggered stop or termination. Use it to save checkpoints, sync output to S3, or notify downstream systems.

**Job arrays** — `spawn launch --count N` launches N identical instances. Each instance gets a set of environment variables so it knows its role:

| Variable | Description |
|----------|-------------|
| `JOB_ARRAY_ID` | Unique array ID (UUID) |
| `JOB_ARRAY_NAME` | Array name (from `--job-array-name`) |
| `JOB_ARRAY_SIZE` | Total instances in the array |
| `JOB_ARRAY_INDEX` | Zero-based index of this instance (0 … N-1) |

Example — shard a dataset across 8 instances:
```bash
spawn launch data-proc --count 8 --job-array-name data-proc \
  --instance-type c6a.xlarge --ttl 2h
# On each instance:
# CHUNK=$((total_chunks / JOB_ARRAY_SIZE))
# START=$((JOB_ARRAY_INDEX * CHUNK))
# process_data --start $START --count $CHUNK
```

**`--region` vs `--regions`** — `spawn` uses `--region` (singular, one value) since a launch targets a single region. `truffle` uses `--regions` / `-r` (plural, comma-separated) since it searches across multiple regions at once. When piping `truffle` output to `spawn`, use the single region from `truffle`'s result:
```bash
region=$(truffle spot c6a.xlarge --sort-by-price --pick-first | jq -r .region)
spawn launch my-job --instance-type c6a.xlarge --region "$region"
```

::: tip
See [TTL vs idle timeout](/reference/configuration#ttl-vs-idle-timeout-—-how-they-interact) for a complete explanation with a worked timeline.
:::

## Programmatic access

Use spawn from Python scripts, notebooks, or FastAPI backends via the [Python SDK](/guides/python-sdk):

```python
import spore

# List running instances
instances = spore.spawn.list()
for inst in instances:
    print(inst.name, inst.state, inst.ttl)

# Poll status until complete
inst = spore.spawn.status("my-job")
inst.wait("terminated")
```

Or poll `spawn status --check-complete` and branch on its exit code (works for a
single instance and, via `spawn sweep status --check-complete`, for sweeps):
```bash
# Exit 0=complete, 1=failed, 2=running, 3=error
while spawn status my-job --check-complete; [ $? -eq 2 ]; do sleep 30; done
```

## Common mistakes

- **`terminate` to "pause" a job.** Terminate destroys the EBS volume and its data — use `stop`/`hibernate` to pause. See [stop vs hibernate vs terminate](/reference/troubleshooting#stop-vs-hibernate-vs-terminate).
- **Expecting `--on-complete` to fire for work you start yourself.** A `--command` signals completion when it exits, pass or fail (its exit code goes to `/tmp/SPAWN_EXITCODE`). Work you start another way, such as over `spawn connect`, has to signal it: run `spored complete` or `touch /tmp/SPAWN_COMPLETE`.
- **Restarting a stopped instance whose TTL already passed.** The TTL is absolute; `spawn extend` first if you need more time.
- **`--region` vs `--regions`.** spawn takes one `--region`; truffle takes plural `--regions` (see above).

Full list: [Troubleshooting & common mistakes](/reference/troubleshooting).

## How it connects

[Truffle](/tools/truffle) tells spawn *what* to launch; spawn launches it and
provisions [spored](/tools/spored), which enforces the lifecycle from the instance.
[Lagotto](/tools/lagotto) can drive `spawn` when it's waiting on capacity, and
[spore-bot](/tools/spore-bot) lets you control spawn-launched instances from chat.

## Full command reference

→ [spawn command reference](/tools/reference/spawn)
