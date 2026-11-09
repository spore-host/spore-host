---
description: "The lifecycle events spored records (TTL, idle, completion, Spot interruption), how to see them in 1.0, and the experimental chat delivery."
---

# Lifecycle Notifications

spored records a lifecycle event when something significant happens to your instance: a TTL warning, an idle stop, a completion, a Spot interruption. This page lists those events and how to see them.

## Seeing lifecycle events (1.0)

- **The spored log.** spored logs its lifecycle decisions (TTL, idle
  detection, completion) whether or not any notification is configured:

  ```sh
  spawn logs training --which spored
  ```

  [Logs and debugging](/guides/logs) covers the log files, and the
  serial-console failure log spored leaves after a termination.
- **Your own webhook, for completion and Spot interruption.** At launch,
  `--completion-webhook-url` and `--spot-webhook-url` make spored `POST` a
  fire-once, best-effort notice to a URL you run (a queue, a CI hook, your own
  service). `--webhook-correlation` echoes an opaque value of yours in the
  payload, and `--webhook-timeout` caps the request. See the
  [`spawn launch` reference](/tools/reference/spawn).

The lifecycle actions themselves (stop, hibernate, terminate) never depend on a
notification being delivered.

::: warning Chat delivery is experimental and not part of 1.0
Pushing events to people (Slack DMs, Teams messages, Discord channels) goes
through spore-bot, and chat-platform integrations are walled off for 1.0. **The
hosted spore-bot is decommissioned as of 2026-11**, so `--slack-workspace` and
`--notify-platform` deliver nothing unless you run your own
[self-hosted spore-bot](/spore-bot-self-hosting) and point `SPORE_NOTIFY_URL` at
it. Everything from [Slack DMs](#slack-dms) down describes that experimental,
unsupported path. See
[spore-host#611](https://github.com/spore-host/spore-host/issues/611).
:::

## What triggers an event

| Event | When | Message |
|-------|------|---------|
| TTL warning | 5 min before TTL expires | ⏱️ *name* terminates in 5 minutes |
| TTL expired | At TTL | 🔴 *name* has terminated — scheduled end time reached |
| Idle warning | 5 min before idle timeout | 💤 *name* will stop in 5 minutes — no activity |
| Idle stopped | At idle timeout (default) | ⏹️ *name* has stopped — idle timeout reached |
| Idle hibernated | At idle timeout with `--on-idle hibernate` | 💤 *name* has hibernated — idle timeout reached |
| Idle stop failed | The idle stop or hibernate failed; the instance is still running | ℹ️ *name*: idle_stop_failed |
| Completion | Completion file detected (a `--command` writes it when it exits) | ✅ *name* has completed |
| Spot interrupt | Spot interruption notice received | ⚠️ *name* received a Spot interruption notice |
| Pre-stop start | Pre-stop hook begins | 🔄 *name* is running its shutdown task |
| Pre-stop failed | The pre-stop hook exited with an error | 🟠 *name* shutdown task FAILED — output may NOT have been saved |
| Pre-stop timeout | The pre-stop hook ran past its timeout | 🟠 *name* shutdown task TIMED OUT — output may be incomplete |
| FSx mount failed | The FSx filesystem could not be mounted | ℹ️ *name*: fsx_mount_failed |
| FSx DRA failed | The FSx link to S3 (data repository association) could not be set up | ℹ️ *name*: fsx_dra_failed |
| Region vacated | No spawn-managed instances remain in the region | ℹ️ *name*: region_vacated |

Events without a dedicated message are delivered with the generic ℹ️ form shown.
[Lifecycle Events](/reference/lifecycle-events) has the full list, including
`completion_stop_failed` and `spot_replacement_retired`.

## Slack DMs

*Experimental, self-hosted spore-bot only.* You receive a direct message in Slack for each event on instances you subscribe to.

**Enable at launch:**
```sh
spawn launch --name training --slack-workspace T03NE3GTY --ttl 8h
```

**Subscribe your user:**
```sh
/spore notify training
```

Or subscribe via CLI:
```sh
spawn notify register --platform slack --user you@lab.edu --workspace-id T03NE3GTY \
  --instance i-0abc123 --nickname training
```

## Channel webhook

*Experimental, self-hosted spore-bot only.* Posts lifecycle events to a shared Slack channel. The webhook URL is captured automatically during your spore-bot's OAuth flow (Add to Slack), or set manually:

```sh
spawn notify workspace add --platform slack --workspace-id T03NE3GTY \
  --bot-token xoxb-... --signing-secret <signing-secret> \
  --webhook-url https://hooks.slack.com/services/...
```

`workspace add` replaces the workspace's whole record, so pass the bot token and
signing secret again along with the webhook; anything you leave out is cleared.

All lifecycle events for any instance in that workspace post to the configured channel.

## Notification-only subscriptions

Subscribe to notifications for an instance you don't own or control — you'll get the DMs without start/stop access:

```sh
/spore notify rstudio
```

Unsubscribe: `/spore unnotify rstudio`

## Responding to warnings

A TTL warning comes 5 minutes before the deadline. To get more time, extend it:

```sh
spawn extend training 4h
```

With a self-hosted spore-bot, `/spore extend training 4h` does the same from chat.

## Disabling specific events

If you want completion and Spot notifications but not TTL/idle warnings, there is no per-event filter today — all events from spored route to all subscribers. Per-event filtering is on the roadmap.

## Teams and Discord

*Experimental, self-hosted spore-bot only.* The platform is chosen at launch with `--notify-platform` (`slack` is the default):

```sh
spawn launch --name training --slack-workspace <TENANT_ID> --notify-platform teams --ttl 8h
spawn launch --name training --slack-workspace <GUILD_ID> --notify-platform discord --ttl 8h
```

`--slack-workspace` carries the workspace ID for every platform. The same events
fire. See [Teams Setup](/guides/teams-setup) and [Discord Setup](/guides/discord-setup)
for configuration; Discord delivers to the channel webhook as embeds.

## Troubleshooting

**Not receiving DMs:** Check that the instance was launched with `--slack-workspace` (or the tag `spawn:slack-workspace-id` is set), and that you've run `/spore notify <nickname>` for your Slack user.

**Receiving duplicate notifications:** Two Slack apps (/spore and /prism) may both be registered for the same workspace. The `spawn:notify-command` tag routes notifications to one app's config. There is no launch flag for it: spawn sets it to `/spore` whenever `--slack-workspace` is given.
