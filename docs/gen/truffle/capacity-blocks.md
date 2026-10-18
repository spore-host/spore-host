## `truffle capacity-blocks`

Discover purchasable EC2 Capacity Block for ML offerings (read-only).

This queries DescribeCapacityBlockOfferings — "what can I reserve?" — and shows
each offering's id, instance type/count, AZ, reservation window (in your local
timezone), duration, and up-front price. The offering id is what 'spawn
capacity-block purchase' reserves. Offerings are listed cheapest-first by default
(--sort start to order by start time instead).

Durations are day-granular: use --days (e.g. --days 1), or --duration-hours,
which is rounded up to a valid Capacity Block duration (1-day steps to 14 days,
then 7-day steps to 182). By default the search covers now → the soonest a block
of that duration could end; use --start-date / --start-after / --end-by to widen
or shift the window (blocks can start up to 8 weeks out).

Searches every enabled region by default, since offerings vary by region; use
--regions to narrow.

For Capacity Blocks you ALREADY own, use 'truffle capacity --blocks' instead.

Examples:
  truffle capacity-blocks --instance-type p5.48xlarge --days 1
  truffle capacity-blocks --instance-type p5.48xlarge --start-date 2026-07-01 --days 2
  truffle capacity-blocks --instance-type p5.48xlarge --duration-hours 48 \
    --region us-east-1 --sort start --output json

```
truffle capacity-blocks [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--all-regions` |  | bool |  | Search every enabled region (already the default here; useful to be explicit in scripts). Cannot be combined with --regions |
| `--count` |  | int | `1` | Number of instances in the block |
| `--days` |  | int |  | Capacity Block duration in days (natural unit for CB-for-ML; e.g. --days 1). Overrides --duration-hours |
| `--duration-hours` |  | int |  | Capacity Block duration in hours (e.g. 24); use --days for whole days |
| `--end-by` |  | string |  | Latest block END time (RFC3339). Default: start + duration + 1d cushion |
| `--instance-type` |  | string |  | Instance type to find offerings for (required, e.g. p5.48xlarge) |
| `--sort` |  | string | `price` | Sort offerings by: price (cheapest first) or start (soonest first) |
| `--start-after` |  | string |  | Earliest block START time (RFC3339, e.g. 2026-07-01T00:00:00Z). Default: now |
| `--start-date` |  | string |  | Search for blocks starting on this calendar day (YYYY-MM-DD), in UTC |
| `--timeout` |  | duration | `5m0s` | Timeout for AWS API calls |

