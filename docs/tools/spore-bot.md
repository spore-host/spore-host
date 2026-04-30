# Spore-bot

Spore-bot connects your Slack or Microsoft Teams workspace to your running instances. Any team member you've authorised can control instances from chat — without a terminal, without AWS credentials, from any device.

## What it does

**Slash commands** (in any channel):

| Command | Action |
|---------|--------|
| `/spore list` | All your registered instances with status |
| `/spore status [name]` | State, type, IP, DNS, TTL countdown |
| `/spore start [name]` | Start a stopped instance |
| `/spore stop [name]` | Stop a running instance |
| `/spore hibernate [name]` | Hibernate (save RAM, stop billing) |
| `/spore extend [name] [duration]` | Extend the TTL |
| `/spore url [name]` | Get the instance URL |
| `/spore connect [duration]` | Generate a one-time code for a collaborator |
| `/spore notify [name]` | Subscribe to DM notifications |
| `/spore unnotify [name]` | Unsubscribe |
| `/spore help` | Command reference |

**Direct message notifications** — lifecycle events arrive as DMs without polling:

- ⏱️ *training terminates in 10 minutes* — time to extend if needed
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
3. Connect your workspace: click "Add to Slack" or run `spawn bot workspace-add`
4. Register instances: `spawn bot register --instance i-0abc123 --nickname rstudio`
5. Enable access: `spawn bot enable --nickname rstudio --user you@lab.edu`

## Access model

- **Per-instance, per-user** — you explicitly grant each user access to each instance
- **Per-action** — control which operations each user can perform (`start,stop,status` etc.)
- **Enabled flag** — access can be suspended without revoking the registration
- **Cross-account IAM** — the Lambda never has broad EC2 access; it can only assume roles you create

## Microsoft Teams

Teams works identically to Slack. See [Teams Setup](/guides/teams-setup).
