# Lifecycle Notifications

spore.host sends notifications when significant things happen to your instances — so you don't have to watch a terminal or poll for status. This guide explains how notifications work and how to configure them.

## What triggers a notification

| Event | When | Message |
|-------|------|---------|
| TTL warning | 5 min before TTL expires | ⏱️ *name* terminates in 5 minutes |
| TTL expired | At TTL | 🔴 *name* has terminated — scheduled end time reached |
| Idle warning | 5 min before idle timeout | 💤 *name* will stop in 5 minutes — no activity |
| Idle stopped | At idle timeout (default) | ⏹️ *name* has stopped — idle timeout reached |
| Idle hibernated | At idle timeout with `--hibernate-on-idle` | 💤 *name* has hibernated — idle timeout reached |
| Completion | Completion file detected | ✅ *name* has completed |
| Spot interrupt | Spot interruption notice received | ⚠️ *name* received a Spot interruption notice |
| Pre-stop start | Pre-stop hook begins | 🔄 *name* is running its shutdown task |

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
spawn bot register --platform slack --user you@lab.edu --workspace-id T03NE3GTY \
  --instance i-0abc123 --nickname training
```

## Channel webhook

Posts lifecycle events to a shared Slack channel — useful for team visibility. The webhook URL is captured automatically during the OAuth flow (Add to Slack), or set manually:

```sh
spawn bot workspace-add --platform slack --workspace-id T03NE3GTY \
  --webhook-url https://hooks.slack.com/services/...
```

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

## Teams

Teams notifications work the same way as Slack. See [Teams Setup](/guides/teams-setup) for configuration. The same events fire; messages arrive as direct messages in Teams.

## Troubleshooting

**Not receiving DMs:** Check that the instance was launched with `--slack-workspace` (or the tag `spawn:slack-workspace-id` is set), and that you've run `/spore notify <nickname>` for your Slack user.

**Receiving duplicate notifications:** Two Slack apps (/spore and /prism) may both be registered for the same workspace. Use `spawn:notify-command` to route notifications to only one. At launch: `--slack-workspace T03... --notify-command /spore`.
