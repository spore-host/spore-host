# Spawn

Spawn launches EC2 instances and manages their full lifecycle. It provisions the spored daemon on each instance, which handles auto-termination, idle detection, DNS, and lifecycle notifications independently of your laptop.

## Install

```sh
brew install scttfrdmn/tap/spawn
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
```

### `spawn stop` / `spawn start`

```sh
spawn stop my-instance
spawn stop my-instance --hibernate    # save RAM state, stop billing
spawn start my-instance
```

### `spawn terminate`

```sh
spawn terminate my-instance
```

### `spawn extend`

Update the TTL on a running instance:

```sh
spawn extend my-instance 4h     # extend by 4 hours from now
```

### `spawn connect`

Get the SSH command and URL for an instance:

```sh
spawn connect my-instance
```

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

### `spawn bot`

Register instances and users for Slack/Teams control:

```sh
spawn bot workspace-add ...
spawn bot register ...
spawn bot enable ...
spawn bot status ...
```

See [Slack Setup](/guides/slack-setup) for the full walkthrough.

## Key concepts

**TTL** — every instance has an absolute termination deadline: `launch_time + TTL`. When it fires, the instance terminates. The deadline is stored in a tag at launch and is **never reset** by stop/wake cycles — it keeps counting even while the instance is stopped. `spawn extend` pushes the deadline forward, not from now.

**Idle timeout** — spored monitors CPU, network, disk, GPU, sessions, and configured process names. When all signals indicate inactivity for the configured duration, the instance **stops** (or hibernates with `--hibernate-on-idle`). The idle timer **resets** every time the instance wakes. Idle timeout never terminates — only TTL does that.

**Spored** — a small daemon that runs on the instance, enforces the TTL deadline, detects idleness, registers DNS, and sends lifecycle notifications. Installed automatically at launch.

**Pre-stop hooks** — a shell command that runs before any lifecycle-triggered stop or termination. Use it to save checkpoints, sync output to S3, or notify downstream systems.

::: tip
See [TTL vs idle timeout](/reference/configuration#ttl-vs-idle-timeout-how-they-interact) for a complete explanation with a worked timeline.
:::

## Full command reference

→ [spawn command reference](/tools/reference/spawn)
