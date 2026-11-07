## `lagotto notify-gc`

Reconcile the email subscriptions on the alerts topic (lagotto-capacity-alerts)
with the active watches in this account and region.

lagotto subscribes each --notify email: address to the alerts topic, with a filter
policy so the address receives only its own watches' events. When no active watch
names an address any more, its subscription is removed: by the hosted poller at
the start of each sweep, by 'lagotto cancel' for the cancelled watch, and by this
command. Run it if the poller cannot (its runtime policy predates the grant: re-run
'lagotto setup'), or to clean up at once.

Only subscriptions lagotto created (they carry its filter policy) are removed. A
subscription that is still pending confirmation has no ARN to unsubscribe by; SNS
deletes it on its own within 3 days.

With --resubscribe it also subscribes every address an active watch names that has
no subscription at all, for example one whose confirmation email was never clicked
and that SNS has since deleted. SNS sends each a new confirmation email.

```
lagotto notify-gc [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--resubscribe` |  | bool |  | Also subscribe active watches' addresses that have no subscription (sends a confirmation email) |

