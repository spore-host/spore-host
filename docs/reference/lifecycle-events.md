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
| `region_vacated` | When an instance terminates and no other spawn-managed instance was running or pending in the region when the termination was decided, nor just before it terminates | ℹ️ *name*: region_vacated |

Events the bot has no dedicated message for are delivered in the generic ℹ️ form.

An instance tagged `spawn:terminate-on-idle` (a `spawn service` instance, a pool
worker or a `spawn burst` member) is terminated at its idle timeout, not stopped,
and that sends no event yet
([spawn#1205](https://github.com/spore-host/spawn/issues/1205)). Users logged in
to it still get spored's terminate warning.
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

The completion event fires when spored detects the file at `spawn:completion-file` (default: `/tmp/SPAWN_COMPLETE`, or the path you gave `--completion-file`). After the delay specified by `spawn:completion-delay` (default: `30s`), it executes the action in `spawn:on-complete`.

A `--command` (or `--mpi-command`, on every member) writes the file itself when
it exits, pass or fail, so you don't need to. It writes the path `--completion-file`
names, creating its directory if needed (since spawn v0.135.2; before, it always
wrote `/tmp/SPAWN_COMPLETE`, so a custom path never fired `--on-complete`). For work you start some other way, signal it at the end of your script:

```sh
touch /tmp/SPAWN_COMPLETE
```

Spored sees the file, sends the `completion` notification, waits 30 seconds, then terminates the instance.

spored checks for the file once a minute, so the instance terminates about
35–95 s after the file appears with the defaults (no pre-stop hook). The full
breakdown is in [How long after the command exits does the instance
terminate?](/tools/spored#how-long-after-the-command-exits-does-the-instance-terminate).

The `region_vacated` check never delays the termination (spored v0.153.0 and
later, [spawn#1456](https://github.com/spore-host/spawn/issues/1456)). Without
a notifier it doesn't run. With one, it counts the region's other spawn-managed
instances when the termination is decided and again just before it, so an
instance relaunched in between suppresses the event; one launched after the
termination does not.
