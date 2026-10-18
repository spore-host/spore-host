---
description: "Spore-bot connects your Slack, Microsoft Teams or Discord workspace to your running instances."
---

# Spore-bot <span class="doc-badge automation">Automation</span> <span class="doc-badge stable">Stable</span>

**What it is.** Spore-bot connects your Slack, Microsoft Teams or Discord workspace
to your running instances.

**When to use it.** When you (or a collaborator) want to check on or control an
instance without opening a terminal or holding AWS credentials — from a phone, a
shared channel, or mid-meeting. Also how lifecycle notifications reach you as DMs.

Any team member you've authorised can control instances from chat — without a
terminal, without AWS credentials, from any device. Setup lives in the [Slack Setup
guide](/guides/slack-setup); the trust model (cross-account role, per-user access)
is in [Security, credentials & data flow](/architecture).

## What it does

**Slash commands** (in any channel):

| Command | Action |
|---------|--------|
| `/spore list` | All your registered instances with status |
| `/spore status [name]` | State, type, IP, DNS, TTL countdown |
| `/spore start [name]` | Start a stopped instance |
| `/spore stop [name]` | Stop a running instance |
| `/spore hibernate [name]` | Hibernate (save RAM; compute billing stops, EBS continues) |
| `/spore extend [name] [duration]` | Extend the TTL |
| `/spore url [name]` | Get the instance URL |
| `/spore connect [duration]` | Generate a one-time code for a collaborator |
| `/spore notify [name]` | Subscribe to DM notifications |
| `/spore unnotify [name]` | Unsubscribe |
| `/spore help` | Command reference |

**Direct message notifications** — lifecycle events arrive as DMs without polling:

- ⏱️ *training terminates in 5 minutes* — time to extend if needed
- ✅ *bert-finetune has completed* — job done, instance is terminating
- 💤 *rstudio has hibernated* — idle timeout reached
- ⚠️ *training received a Spot interruption notice*

## How it works

Spore-bot is a Lambda function running in the spore.host infrastructure account. When you type `/spore stop rstudio`, Slack sends a signed webhook to the Lambda, which:

1. Verifies the Slack signature
2. Looks up your registration in DynamoDB
3. Assumes your cross-account IAM role
4. Calls `ec2:StopInstances` in your AWS account
5. Responds to Slack with the result

Your AWS credentials never leave your account — the Lambda only assumes the narrow cross-account role you grant it.

## Setup

See the full [Slack Setup guide](/guides/slack-setup) for step-by-step instructions. The short version:

1. Create a Slack app at api.slack.com/apps
2. Add the OAuth redirect URL and configure the `/spore` slash command
3. Connect your workspace: click "Add to Slack" or run `spawn notify workspace add`
4. Register instances: `spawn notify register --platform slack --workspace-id T0... --user you@lab.edu --instance i-0abc123 --nickname rstudio` (it prints the Slack user ID the email resolved to)
5. Enable access: `spawn notify enable --platform slack --workspace-id T0... --user-id U04KZABCD --nickname rstudio` (`--user-id` is required)
6. Launch with notifications: `spawn launch --slack-workspace T0... ...`

## Access model

- **Per-instance, per-user** — you explicitly grant each user access to each instance
- **Per-action** — control which operations each user can perform (`start,stop,status` etc.)
- **Enabled flag** — access can be suspended without revoking the registration
- **Cross-account IAM** — the Lambda never has broad EC2 access; it can only assume roles you create

## Microsoft Teams and Discord

Teams works like Slack; launch with `--notify-platform teams` so the instance's
events are sent as Teams events. See [Teams Setup](/guides/teams-setup).

Discord delivers notifications to a channel webhook as embeds; launch with
`--notify-platform discord`. See [Discord Setup](/guides/discord-setup).
