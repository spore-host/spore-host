---
description: "Spored emits lifecycle events when significant things happen to a running instance."
---

# Lifecycle Events

Spored emits lifecycle events when significant things happen to a running instance. Events are routed through the spore-bot Lambda to Slack DMs, Teams messages, or a Discord channel webhook, depending on `--notify-platform` at launch.

## Event types

| Event | When it fires | Default message |
|-------|--------------|-----------------|
| `ttl_warning` | 5 minutes before TTL expires | ⏱️ *name* terminates in 5 minutes |
| `ttl_expired` | At TTL expiry | 🔴 *name* has terminated — scheduled end time reached |
| `idle_warning` | 5 minutes before idle timeout | 💤 *name* will stop in 5 minutes — no activity detected |
| `idle_stopped` | At idle timeout (default) | ⏹️ *name* has stopped — idle timeout reached |
| `idle_hibernated` | At idle timeout with `--on-idle hibernate` | 💤 *name* has hibernated — idle timeout reached |
| `idle_stop_failed` | The idle stop or hibernate failed; the instance is still running and spored retries with backoff | ℹ️ *name*: idle_stop_failed |
| `completion` | When `spawn:completion-file` is detected | ✅ *name* has completed |
| `completion_stop_failed` | The on-complete stop or hibernate failed; spored retries with backoff | ℹ️ *name*: completion_stop_failed |
| `spot_interrupt` | On Spot interruption notice | ⚠️ *name* received a Spot interruption notice |
| `spot_replacement_retired` | A replacement launched from a leaked Spot request was found and terminated (sent to the original instance's users) | ℹ️ *name*: spot_replacement_retired |
| `pre_stop_start` | When pre-stop hook begins | 🔄 *name* is running its shutdown task before terminating |
| `pre_stop_failed` | The pre-stop hook exited with an error | 🟠 *name* shutdown task FAILED — output may NOT have been saved |
| `pre_stop_timeout` | The pre-stop hook ran past `spawn:pre-stop-timeout` | 🟠 *name* shutdown task TIMED OUT — output may be incomplete |
| `fsx_mount_failed` | The FSx filesystem could not be mounted | ℹ️ *name*: fsx_mount_failed |
| `fsx_dra_failed` | The FSx data repository association (S3 link) could not be set up | ℹ️ *name*: fsx_dra_failed |
| `region_vacated` | No spawn-managed instances remain in the region | ℹ️ *name*: region_vacated |

Events the bot has no dedicated message for are delivered in the generic ℹ️ form.
A cost-limit warning is not an event: at 90% of `spawn:cost-limit`, spored warns
logged-in users with `wall` and writes `/tmp/SPAWN_WARNING`.

## Receiving events

Events reach you as Slack DMs or Teams messages. To enable:

1. Set `--slack-workspace` when launching (or `spawn defaults set slack-workspace <ID>`), plus `--notify-platform teams` or `--notify-platform discord` if you're not on Slack
2. Run `/spore notify <nickname>` in Slack to subscribe your user

Without a subscription, events are posted to the channel webhook (if configured) but not sent as DMs.

## Warning thresholds

The 5-minute warning is fixed. If you need to respond (extend TTL, save work), you have that window. The warning fires once — subsequent checks within the same warning window don't re-trigger it.

## Completion events

The completion event fires when spored detects the file at `spawn:completion-file` (default: `/tmp/SPAWN_COMPLETE`). After the delay specified by `spawn:completion-delay` (default: `30s`), it executes the action in `spawn:on-complete`.

A `--command` writes the file itself when it exits, pass or fail, so you don't
need to. For work you start some other way, signal it at the end of your script:

```sh
touch /tmp/SPAWN_COMPLETE
```

Spored sees the file, sends the `completion` notification, waits 30 seconds, then terminates the instance.
