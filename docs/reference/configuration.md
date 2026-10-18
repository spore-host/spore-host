---
description: "spore.host reads configuration from three sources, in order of precedence (highest first):"
---

# Configuration

spore.host reads configuration from three sources, in order of precedence (highest first):

1. **CLI flags** — `--ttl 8h`, `--slack-workspace T03NE3GTY`
2. **Defaults file** — `~/.spawn/config.yaml`
3. **EC2 tags** — set on the instance at launch, read by spored at startup

## Defaults file (`~/.spawn/config.yaml`)

Manage with `spawn defaults`:

```sh
spawn defaults set <key> <value>
spawn defaults unset <key>
spawn defaults list
```

### Available keys

| Key | CLI flag | Description |
|-----|----------|-------------|
| `slack-workspace` | `--slack-workspace` | Slack workspace ID for lifecycle notifications |
| `active-processes` | `--active-processes` | Process names that keep an instance alive (comma-separated) |
| `active-ports` | `--active-ports` | TCP ports whose connections are counted and reported (comma-separated). They don't prevent idle |
| `idle-timeout` | `--idle-timeout` | Default idle timeout duration — stops the instance when idle |
| `hibernate-on-idle` | `--on-idle hibernate` | Hibernate instead of stopping on idle (`true`/`false`) |

### File format

The file is YAML. You can edit it directly at `~/.spawn/config.yaml`:

```yaml
dns:
  enabled: true
  domain: spore.host

defaults:
  slack_workspace: T03NE3GTY
  idle_timeout: 1h
  active_processes: rsession
  hibernate_on_idle: false
```

## EC2 tags

Spored reads its configuration from EC2 tags on the instance at startup. These are set automatically when you use the corresponding CLI flags. You can also set them manually via the AWS console or CLI.

| Tag | Set by flag | Description |
|-----|-------------|-------------|
| `spawn:ttl` | `--ttl` | Time-to-live duration (e.g. `8h`, `2d`) |
| `spawn:idle-timeout` | `--idle-timeout` | Idle timeout duration |
| `spawn:hibernate-on-idle` | `--on-idle hibernate` | `true` to hibernate instead of stop |
| `spawn:active-processes` | `--active-processes` | Comma-separated process names |
| `spawn:active-ports` | `--active-ports` | Comma-separated TCP port numbers whose connections are counted (they don't prevent idle) |
| `spawn:on-complete` | `--on-complete` | Action on completion: `terminate`, `stop`, `hibernate` |
| `spawn:completion-file` | `--completion-file` | Path to watch for completion signal |
| `spawn:completion-delay` | `--completion-delay` | Grace period before acting on completion |
| `spawn:pre-stop` | `--pre-stop` | Shell command to run before shutdown |
| `spawn:pre-stop-timeout` | `--pre-stop-timeout` | Max wait time for pre-stop (default: `5m`, Spot: `90s`) |
| `spawn:dns-name` | `--name` / `--dns` | DNS label for this instance (not written with `--no-dns`) |
| `spawn:slack-workspace-id` | `--slack-workspace` | Slack workspace ID |
| `spawn:notify-url` | (automatic) | Lambda URL for lifecycle notifications |
| `spawn:notify-command` | (automatic) | Slash command for workspace routing |
| `spawn:idle-cpu` | (no flag; set the tag) | CPU percentage below which instance is considered idle (default `5`) |
| `spawn:ttl-deadline` | (automatic) | Absolute RFC3339 termination deadline, set at launch |
| `spawn:managed` | (automatic) | Set to `true` on all spawn-managed instances |

::: tip
You can update tags on a running instance and spored will pick up the change on the next check cycle (every 60 seconds). `spawn extend` updates both `spawn:ttl` and `spawn:ttl-deadline`.
:::

## TTL vs idle timeout — how they interact

These two settings work together but have very different semantics. Understanding the difference is important.

### TTL — the hard deadline

`--ttl 12h` sets an absolute termination time: **launch time + 12 hours**. This deadline:

- Is computed once at launch and stored in the `spawn:ttl-deadline` EC2 tag
- Is **never reset** by stop/wake cycles — the clock keeps running even while the instance is stopped or hibernated
- Always terminates when it fires. It isn't the only thing that can terminate the instance: a `--cost-limit` and `--on-complete terminate` do too

`spawn extend` adds time to the current deadline, not to the current clock:

```sh
# Instance launched 3h ago with --ttl 12h → deadline in 9h
spawn extend my-instance 4h   # new deadline in 13h, not 4h from now
```

### Idle timeout — the activity monitor

`--idle-timeout 30m` watches for inactivity and **stops** the instance when it goes idle (or **hibernates** with `--on-idle hibernate`). This timer:

- **Does reset** every time the instance wakes up from a stop or hibernate
- Does **not** terminate the instance — it only stops/hibernates it
- Is useful for saving compute costs during quiet periods between tasks

```sh
# --ttl: hard deadline, terminates at launch_time + 12h
# --idle-timeout: stops if idle for 30m; resets on each wake
spawn launch --name analysis --instance-type c8a.2xlarge \
  --ttl 12h \
  --idle-timeout 30m
```

### A complete lifecycle

```
T+0h       launch (TTL deadline: T+12h)
T+1h       job finishes, instance goes idle
T+1h 30m   idle timeout fires → instance STOPS
T+5h       spawn connect → instance wakes, idle timer resets
T+5h 30m   user disconnects, instance goes idle again
T+6h       idle timeout fires → instance STOPS again
T+12h      TTL deadline fires → instance TERMINATES
```

The TTL ensures the instance is eventually cleaned up. The idle timeout saves money during the gaps.
