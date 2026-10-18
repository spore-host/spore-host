---
description: "spore.host sends notifications when significant things happen to your instances — so you don't have to watch a terminal or poll for status."
---

# Lifecycle Notifications

spore.host sends notifications when significant things happen to your instances — so you don't have to watch a terminal or poll for status. This guide explains how notifications work and how to configure them.

## What triggers a notification

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

The most useful notification channel for individuals. You receive a direct message in Slack for each event on instances you subscribe to.

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

Posts lifecycle events to a shared Slack channel — useful for team visibility. The webhook URL is captured automatically during the OAuth flow (Add to Slack), or set manually:

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

When you receive a TTL warning, you have 5 minutes to extend if you need more time:

```
/spore extend training 4h
```

From the CLI:
```sh
spawn extend training 4h
```

## Disabling specific events

If you want completion and Spot notifications but not TTL/idle warnings, there is no per-event filter today — all events from spored route to all subscribers. Per-event filtering is on the roadmap.

## Teams and Discord

The platform is chosen at launch with `--notify-platform` (`slack` is the default):

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
