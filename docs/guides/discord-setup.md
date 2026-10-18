---
description: "Connecting spore.host to Discord posts instance lifecycle notifications — TTL warnings, idle stops, spot interruptions, completion — to a channel of your cho…"
---

# Discord Setup

Connecting spore.host to Discord posts instance lifecycle notifications —
TTL warnings, idle stops, spot interruptions, completion — to a channel of your
choice, as color-coded embeds.

> **Status:** Phase 1 ships **notifications** (this guide). Discord slash
> commands (`/spore list|status|extend|stop`) are Phase 2 — see
> [spore-host/spawn#2](https://github.com/spore-host/spawn/issues/2).

## What you'll get

Channel notifications for lifecycle events, as Discord embeds color-coded by
severity:
- ⏱️ **rstudio terminates in 5 minutes** (yellow)
- ✅ **bert-finetune has completed** (green)
- 💤 **analysis has hibernated — idle timeout reached** (red)
- ⚠️ **training received a Spot interruption notice** (yellow)

Each embed carries the instance ID, region, and URL.

## Step 1: Create a Discord channel webhook

The simplest delivery path — no bot user required for notifications.

1. In Discord, open the target channel's **Edit Channel → Integrations →
   Webhooks**.
2. **New Webhook**, name it `spore-bot`, pick the channel, **Copy Webhook URL**
   (looks like `https://discord.com/api/webhooks/<id>/<token>`).

## Step 2: Create a Discord application

`spawn notify workspace add --platform discord` requires the application's public
key, so you need an application even if you only want notifications.

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
   → **New Application**, name it `spore-bot`.
2. On the **General Information** page, copy the **Public Key** (hex) — this is
   what verifies inbound interactions (Discord has no signing secret).
3. Under **Bot**, add a bot and copy its **token** if you want bot DMs later.

## Step 3: Register the workspace with spawn

Store the webhook and the application public key so the spore-bot service can
deliver to your channel. Your Discord **server (guild)
ID** is the workspace ID — enable Developer Mode in Discord, right-click the
server, **Copy Server ID**.

```bash
spawn notify workspace add \
  --platform discord \
  --workspace-id <GUILD_ID> \
  --workspace-name "My Server" \
  --webhook-url "https://discord.com/api/webhooks/<id>/<token>" \
  --public-key <APPLICATION_PUBLIC_KEY>
```

`--public-key` is required for `--platform discord`; the command refuses to run
without it. The `--webhook-url` is what notifications are delivered to. (Discord
uses the public key for Ed25519 interaction verification, not a signing secret —
so `--signing-secret` does not apply to `--platform discord`.)

## Step 4: Launch with Discord notifications

Tell the instance to route lifecycle notifications to Discord:

```bash
spawn launch rstudio --instance-type r7i.xlarge \
  --slack-workspace <GUILD_ID> \
  --notify-platform discord
```

(`--slack-workspace` is the workspace-id flag — it carries the Discord guild ID
here; the flag name is shared across platforms.) The instance is tagged
`spawn:notify-platform=discord` and `spawn:slack-workspace-id=<GUILD_ID>`, and
spored sends its lifecycle events to the spore-bot `/notify` endpoint, which
posts the embed to your channel webhook.

That's it — you'll see embeds in the channel as the instance warns, stops, or
completes.

## Phase 2: Slash commands (`/spore` in your own server)

Add the spore-bot **application** to your guild so members can run
`/spore list|status|start|stop|hibernate|url|extend|connect` — your instances,
your server. This is separate from the community spore.host server; you install
the app wherever you want to control spores.

### 1. Configure the application

In your Discord application (from Step 2 above):

1. **General Information → Interactions Endpoint URL**: set it to the spore-bot
   service URL with a `/discord` suffix, e.g.
   `https://<spore-bot-function-url>/discord`. Discord sends a signed PING;
   spore-bot answers the PONG, so save succeeds only once the endpoint is live
   and your application **Public Key** is registered (Step 3 below).
2. **Installation / OAuth2**: add an install link with the `applications.commands`
   (and `bot`, if you want notifications via the bot) scopes, then add the app to
   your server.

### 2. Register the slash command (one-time)

```bash
DISCORD_APP_ID=<application-id> DISCORD_BOT_TOKEN=<bot-token> \
  ./scripts/register-discord-commands.sh
# fast testing in a single guild (instant vs ~1h global propagation):
DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… DISCORD_TEST_GUILD_ID=<guild> \
  ./scripts/register-discord-commands.sh
```

### 3. Register your guild + its public key

So spore-bot can verify your guild's interactions and map commands to your
instances:

```bash
spawn notify workspace add --platform discord \
  --workspace-id <YOUR_GUILD_ID> \
  --public-key <APPLICATION_PUBLIC_KEY>
spawn notify register --platform discord \
  --workspace-id <YOUR_GUILD_ID> --user-id <YOUR_DISCORD_USER_ID> \
  --instance i-0abc… --nickname rstudio --allow status,stop,extend
```

Now `/spore status rstudio` in your server returns your instance's state, TTL,
and URL; `/spore extend rstudio 4h` extends its deadline — all verified against
your application's Ed25519 key. The bot replies "thinking…" and edits in the
result (Discord's 3-second deadline is met by a deferred response).
