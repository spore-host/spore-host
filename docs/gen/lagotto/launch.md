## `lagotto launch`

Schedule an instance launch to fire at a clock time (--at), after a delay
(--after), or on a recurring cron (--cron) — as opposed to 'watch', which fires
when capacity appears. The motivating case is launching into an EC2 Capacity
Block at its reserved start time:

  lagotto launch --at 2026-07-01T08:00:00Z --spawn-config block.yaml

where block.yaml sets reservation_id + capacity_block.

This is driven by EventBridge Scheduler in the hosted poller stack, so it
requires 'lagotto deploy' to have been run (the schedule targets the poller
Lambda in your account). The launched instance always carries a TTL (#38).

```
lagotto launch [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--after` |  | string |  | Fire once after this delay (e.g. 6h, 30m, 2d) |
| `--at-reservation-start` |  | bool |  | Fire at the reservation's start time (derived from the reservation), retrying through the window open until the instance runs (requires --reservation-id) |
| `--at` |  | string |  | Fire once at this RFC3339 time (e.g. 2026-07-01T08:00:00Z) |
| `--az` |  | string |  | Availability zone (required to match a Capacity Block's AZ) |
| `--cron` |  | string |  | Fire on this cron schedule (e.g. '0 9 ? * MON-FRI *') |
| `--fire-early` |  | duration | `2m0s` | With --at-reservation-start: fire this long before the window open so a Scheduler delay doesn't burn paid time |
| `--if-exists` |  | string |  | If an instance with this Name already exists at fire time: skip\|launch\|replace (default: skip for --at/--after, launch for --cron) |
| `--name` |  | string |  | Instance Name tag (the overlap dedup key); defaults to the spawn config's name |
| `--region` |  | string |  | AWS region to launch in (default: from your AWS config) |
| `--reservation-id` |  | string |  | Capacity Block reservation id (cr-…) to launch into |
| `--retry-interval` |  | duration | `30s` | With --at-reservation-start: how often to retry through the boundary until the launch succeeds |
| `--spawn-config` |  | string |  | spawn LaunchConfig YAML (required): a local path, an s3://bucket/key URI, or '-' for stdin. Referenced user_data_file / iam_policy_file are read now and stored inline. |
| `--stack-name` |  | string | `lagotto` | (deprecated, ignored — the poller has a fixed name) |

