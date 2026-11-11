## `lagotto cancel`

Cancel an active watch (w-…), a watch group (its name, from 'lagotto watch
--group'), or a scheduled launch (sl-…, from 'lagotto launch').

A group: the group ends, and every active member is cancelled as a watch is,
with the tombstone "group &lt;name&gt; cancelled". A member's launch still landing
is not terminated (its TTL applies); a member's pending reservation is
released.

A watch: any capacity reservation it recorded is released, and
each email address it notifies is unsubscribed from the alerts topic unless another
active watch still names it.

For a --action hold watch that already fired (status: matched), cancel releases
the reservation it holds. The reservation is targeted and bills at the On-Demand
rate until its 30-minute window ends, so release it as soon as you know you
won't launch into it. The watch keeps its matched status. Releasing a
reservation that already expired or was already released is not an error.

A scheduled launch: the launch is marked cancelled, then its EventBridge
schedule and any boundary-retry schedules (-r&lt;n&gt;) are deleted. A schedule that
is already gone is not an error. A one-shot launch that already fired is
refused: there is nothing left to cancel. A --cron launch can be cancelled at
any time; it stops future fires. Cancelling an already-cancelled launch deletes
any schedule left behind. The record is in the region 'launch' ran in; pass
--region if that is not your default.

```
lagotto cancel <watch-id | scheduled-launch-id | group> [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--region` |  | string |  | AWS region of the watch or scheduled launch (default: from your AWS config) |
| `--yes` | `-y` | bool |  | Skip the confirmation prompt |

