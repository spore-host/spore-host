---
description: "Connecting spore.host to Slack gives you /spore commands in any channel and direct message notifications when your instances change state — useful whenever y…"
---

# Slack Setup

Connecting spore.host to Slack gives you `/spore` commands in any channel and direct message notifications when your instances change state — useful whenever you're away from the terminal.

## What you'll get

**Slash commands** — type these in any Slack channel:
```
/spore list                    — all your registered instances
/spore status rstudio          — current state, type, URL, TTL countdown
/spore start rstudio           — start a stopped instance
/spore stop rstudio            — stop a running instance
/spore extend rstudio 4h       — extend the auto-terminate deadline
/spore hibernate rstudio       — hibernate (save RAM state; compute billing stops, EBS continues)
/spore connect                 — generate a one-time code for a collaborator
/spore notify rstudio          — subscribe to DM notifications for this instance
/spore help                    — command reference
```

**Direct message notifications** for lifecycle events:
- ⏱️ *rstudio terminates in 5 minutes*
- ✅ *bert-finetune has completed*
- 💤 *analysis has hibernated — idle timeout reached*
- ⚠️ *training received a Spot interruption notice*

## Step 1: Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch**
2. Name it `spore-bot` (or whatever you prefer) and pick your workspace
3. Under **OAuth & Permissions → Bot Token Scopes**, add:
   - `commands`
   - `chat:write`
   - `users:read`
   - `users:read.email`
   - `incoming-webhook`
4. Under **Slash Commands**, create a new command:
   - Command: `/spore`
   - Request URL: `https://awdzf7fbbsvqcrnrzusqjsuybm0iiyvf.lambda-url.us-east-1.on.aws/slack`
   - Short Description: `Control your spore.host instances`
5. Under **Settings → Basic Information**, enable **Token Rotation** under App Credentials
6. Install the app to your workspace — Slack will ask which channel to post notifications to

## Step 2: Connect your workspace

After installing the app, you can either use the OAuth flow (recommended) or register manually.

### OAuth flow (recommended)

Click **Add to Slack** and authorize the app. The Lambda automatically stores your bot token and signing secret.

::: tip
Your "Add to Slack" URL is:
```
https://awdzf7fbbsvqcrnrzusqjsuybm0iiyvf.lambda-url.us-east-1.on.aws/spore/oauth
```
:::

### Manual registration

```sh
spawn notify workspace add \
  --platform slack \
  --workspace-id T03NE3GTY \
  --workspace-name "My Workspace" \
  --bot-token xoxb-... \
  --signing-secret abc123...
```

Your workspace ID appears in your Slack URL: `https://app.slack.com/client/T03NE3GTY/...`

## Step 3: Register an instance

Once the workspace is connected, register your instances so spore-bot can find them:

```sh
spawn notify register \
  --platform slack \
  --user you@university.edu \
  --workspace-id T03NE3GTY \
  --instance i-0a1b2c3d4e5f \
  --nickname rstudio \
  --allow start,stop,status,hibernate,url

spawn notify enable \
  --platform slack \
  --user-id U04KZABCD \
  --workspace-id T03NE3GTY \
  --nickname rstudio
```

`register` accepts an email (`--user`) and resolves it with Slack's
`users.lookupByEmail`, printing the Slack user ID it found
(`Resolved you@university.edu → Slack user ID U04KZABCD`). `enable` (and `disable`)
needs that ID: `--user-id` is required, alongside `--platform`, `--workspace-id`
and `--nickname`.

The `--nickname` is what you'll use in Slack commands (`/spore status rstudio`). The `--allow` flag controls which operations this user can perform.

## Step 4: Enable notifications at launch

Set the `--slack-workspace` flag when launching to enable DM notifications:

```sh
spawn launch \
  --name rstudio \
  --instance-type r6i.2xlarge \
  --ttl 8h \
  --slack-workspace T03NE3GTY
```

Or save it as a default so you never have to type it:

```sh
spawn defaults set slack-workspace T03NE3GTY
```

## Adding collaborators

Give a collaborator access to an instance without giving them AWS credentials. They can start, stop, and check status entirely from Slack.

```sh
# Register a collaborator by email
spawn notify register \
  --platform slack \
  --user collaborator@partner.edu \
  --workspace-id T03NE3GTY \
  --instance i-0a1b2c3d4e5f \
  --nickname rstudio \
  --allow status,start,stop

# Use the user ID that register printed
spawn notify enable \
  --platform slack \
  --user-id U05COLLAB1 \
  --workspace-id T03NE3GTY \
  --nickname rstudio
```

Alternatively, generate a one-time connect code that the collaborator uses themselves:

```sh
/spore connect     # generates a code like SPORE-XXXXXX
```

Share the code with the collaborator. They run:

```sh
spawn notify register --connect-code SPORE-XXXXXX --nickname rstudio
```

## Notification-only subscriptions

If a collaborator wants DM notifications but shouldn't control the instance:

```
/spore notify rstudio
```

This subscribes them to all lifecycle notifications for `rstudio` without granting start/stop access.

To unsubscribe: `/spore unnotify rstudio`

## Troubleshooting

**Commands return "workspace not found"** — check that the signing secret in your Slack app matches what was registered. Signing secrets are regenerated if you change your app's scopes. Re-register with the new secret:

```sh
spawn notify workspace add --platform slack --workspace-id T0... \
  --bot-token xoxb-... --signing-secret <new-secret>
```

`workspace add` replaces the whole workspace record, so include the bot token (and
`--webhook-url`, if you set one) again.

**Not receiving DM notifications** — make sure the instance was launched with `--slack-workspace` and that you've run `/spore notify <nickname>` for your user.
