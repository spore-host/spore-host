---
description: "The payload shape of spored's lifecycle events — for building webhooks and automation on top of spore.host."
---

# Event schemas

spored emits a lifecycle event when something significant happens to an instance
(TTL warning, completion, Spot interruption, …). Events are delivered as an HTTP
`POST` to the notification endpoint (`spawn:notify-url`), which routes them to
Slack, Teams or Discord. This page documents the payload shape so you can build automation on
top of it.

For *when* each event fires and its human-readable message, see
[Lifecycle Events](/reference/lifecycle-events). For enabling delivery to Slack or
a channel webhook, see [Lifecycle Notifications](/guides/notifications).

## Notification payload

Each event is a JSON object with these fields:

| Field | Type | Always present | Description |
|-------|------|----------------|-------------|
| `event_type` | string | yes | The event, e.g. `ttl_warning`, `completion`, `spot_interrupt`. See the [event type list](/reference/lifecycle-events#event-types). |
| `instance_name` | string | yes | The instance nickname (or ID if unnamed). |
| `instance_id` | string | yes | The EC2 instance ID. |
| `region` | string | yes | AWS region of the instance. |
| `platform` | string | yes | Delivery platform: `slack` (the default), `teams` or `discord`, from `spawn:notify-platform`. |
| `workspace_id` | string | yes | Target workspace (Slack workspace, Teams tenant or Discord guild) for routing. |
| `command` | string | no | Slash-command app to route to (e.g. `/spore`) — disambiguates multiple registered apps. |
| `dns_name` | string | no | The instance's spore.host FQDN, when DNS registration is enabled. |
| `detail` | string | no | Free-text detail for the event (e.g. completion status/message). |
| `original_instance_id` | string | no | Only on `spot_replacement_retired`: the instance the Spot replacement was launched for, whose registered users receive the event. |
| `pkcs7` | string | no | The instance's PKCS#7-signed EC2 identity document, from IMDS. (`instance_identity_document` / `instance_identity_signature` exist in the schema but spored doesn't fill them.) |

```json
{
  "event_type": "completion",
  "instance_name": "bert-finetune",
  "instance_id": "i-0abc123def456xyz",
  "region": "us-east-1",
  "platform": "slack",
  "workspace_id": "T03ABCDEF",
  "command": "/spore",
  "dns_name": "bert-finetune.5k0zfnmq.spore.host",
  "detail": "1000 parameter combinations done"
}
```

::: tip Fire-and-forget delivery
Notifications are sent fire-and-forget: a slow or unavailable endpoint **never**
delays or cancels the underlying lifecycle action. Don't rely on a notification
being received as a precondition for a stop/terminate having happened.
:::

## Channel webhooks

Beyond the routed Slack/Teams DMs, you can post events to a shared Slack channel
webhook. Set it with `spawn notify workspace add --webhook-url https://hooks.slack.com/...`
(with the workspace's bot token and signing secret, since `workspace add` replaces
the whole record), or have it captured automatically during the Add-to-Slack OAuth
flow. Discord always delivers to its channel webhook, set the same way. All events for any
instance in that workspace post to the channel. Today there is no per-event filter;
all events route to all subscribers. See
[Lifecycle Notifications](/guides/notifications).

## Verifying event authenticity

When present, the `pkcs7` field carries AWS's signed EC2 instance identity, which
a receiver of your own can verify to confirm the event came from the instance it
names. The hosted spore-bot Lambda does **not** verify it. Its control is
registration: it sends DMs (and SMS) only for an instance registered in the target
workspace, and otherwise posts to the workspace's channel webhook only.

## Related

- **[Lifecycle Events](/reference/lifecycle-events)** — triggers, timing, messages
- **[Lifecycle Notifications](/guides/notifications)** — enabling delivery
- **[EC2 Tags](/reference/ec2-tags)** — the `spawn:notify-*` tags that configure delivery
