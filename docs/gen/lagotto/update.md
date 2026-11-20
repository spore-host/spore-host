## `lagotto update`

Change what an existing watch hunts for (its instance types, regions, AZs,
Spot, maximum price), who it tells (--notify), its spawn config, or its project,
without cancelling it. The watch keeps its ID, its attempt count, last error,
match history and email subscriptions, and keeps hunting throughout.

The updated watch is checked exactly as 'lagotto watch' checks a new one
(including default-subnet coverage and the instance-role check), so an update
cannot produce a watch 'watch' would refuse. Its action, service, owner, ID and
deadline (TTL, or the until-landed acknowledgement deadline) cannot be changed:
use 'lagotto extend' or 'lagotto ack' for the deadline, and a new watch for a
different action.

When the search changes, the state the poller derived from the old search is
cleared: the consecutive-failure count, the quota-refused candidates and the
quota cap. An email address you add is subscribed (and must confirm); one you
remove is unsubscribed unless another active watch names it; the others keep
their confirmed subscriptions. The change is recorded as an 'updated' row in
'lagotto history'.

An update is refused while the poller is acting on the watch (try again in a
moment), while a launch or hold it made is still landing, and while a SageMaker
job it submitted is in flight. An expired or failed watch is only updated with
--reactivate, which also makes it active again; it must still be before its
deadline (run 'lagotto extend' first if not).

--require-quota applies 'watch --require-quota' to a fleet watch's updated
search: the update is refused (exit status 3) only when the quota was read in
every region and provably can't hold the fleet.

--dry-run shows the change, after every check, without writing anything.

A scheduled launch (sl-…, from 'lagotto launch') takes only --spawn-config
(#309): the new config is checked exactly as 'lagotto launch' checks one (its
reservation re-applied, its iam_role checked against the deployed poller), and
only then swapped in with one conditional write. Its EventBridge schedule is
not touched, so a refused config leaves the launch armed with the old one, and
the update fails, writing nothing, if the launch fired, was cancelled or was
updated since it was read. Use it instead of cancelling and re-launching: a
re-launch that is refused leaves nothing armed.

```
lagotto update <watch-id | sl-id> [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--add-notify` |  | stringSlice |  | Add notification channels |
| `--add-region` |  | stringSlice |  | Add regions to the watch's region list (comma-separated) |
| `--add-type` |  | stringSlice |  | Add instance types or patterns to the pattern (comma-separated) |
| `--azs` |  | stringSlice |  | Replace the availability zones (comma-separated; '' = all AZs in the region) |
| `--dry-run` |  | bool |  | Show the change without writing anything |
| `--instance-type` |  | string |  | Replace the instance-type pattern (wildcards and comma-separated rungs, as for 'watch') |
| `--max-price` |  | float64 |  | Replace the maximum price per hour (0 = any) |
| `--no-spot` |  | bool |  | Watch for On-Demand capacity |
| `--notify` |  | stringSlice |  | Replace the notification channels (email:, webhook:, sns:; '' = none) |
| `--project` |  | string |  | Replace the project label ('' = none) |
| `--reactivate` |  | bool |  | Allow updating an expired or failed watch, and make it active again |
| `--regions` | `-r` | stringSlice |  | Replace the regions (comma-separated; '' = all enabled regions) |
| `--remove-notify` |  | stringSlice |  | Remove notification channels |
| `--remove-region` |  | stringSlice |  | Remove regions from the watch's region list (comma-separated) |
| `--require-quota` |  | bool |  | For a --maintain fleet watch: refuse the update (exit status 3) when the account's EC2 vCPU quota, read in every region of the updated watch, provably can't hold its workers, as 'watch --require-quota' does. An unreadable quota is unknown, not zero: the update then goes ahead, with a note. |
| `--spawn-config` |  | string |  | Replace the spawn config (--action spawn watches): a local path, s3://bucket/key or '-' for stdin, read and stored as 'watch' does |
| `--spot` |  | bool |  | Watch for Spot capacity |

