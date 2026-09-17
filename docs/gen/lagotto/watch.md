## `lagotto watch`

Watch for EC2 instance availability across regions and AZs.

The pattern supports wildcards: "p5.*" matches all p5 sizes, "g5.xlarge" is exact.
When capacity is found matching your criteria, the configured action is taken.

```
lagotto watch <instance-type-pattern> [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--action` |  | string | `notify` | Action on match: notify, spawn, hold |
| `--azs` |  | stringSlice |  | Availability zones to pin/order within the region(s), comma-separated (e.g. us-west-2b,us-west-2c). Empty = all AZs. AZ breadth is free (same-region data locality), so all AZs are tried each poll. |
| `--maintain` |  | int |  | Goal-driven fleet: maintain this many workers (relaunching toward the goal, even from zero) until --until holds. Requires --action spawn. 0 = single-shot (default). |
| `--max-price` |  | float64 |  | Maximum acceptable price per hour (0 = any) |
| `--notify` |  | stringSlice |  | Notification channels (e.g., email:user@example.com, webhook:https://...) |
| `--project` |  | string |  | Project label for scoping a local 'poll --daemon --project' in a shared account (default: $LAGOTTO_PROJECT) |
| `--regions` | `-r` | stringSlice |  | Regions to watch (comma-separated; empty = all enabled). Widening across regions can break data co-location (cross-region egress) — prefer --azs within your data's region first. |
| `--sagemaker-config` |  | string |  | YAML/JSON file with the SageMaker job definition (required for --service sagemaker) |
| `--service` |  | string | `ec2` | Capacity service: ec2, or sagemaker (submits your SageMaker job for ml.* types) |
| `--spawn-config` |  | string |  | spawn LaunchConfig YAML (required for --action spawn): a local path, an s3://bucket/key URI, or '-' for stdin. Any user_data_file / iam_policy_file it references is read now and stored inline, so a hosted poller can launch it with no access to this machine. |
| `--spot` |  | bool |  | Watch for Spot capacity (default: On-Demand) |
| `--ttl` |  | string | `24h` | How long to keep watching (e.g., 24h, 7d) |
| `--until` |  | string |  | Fleet completion condition, re-checked each poll: 's3-empty: s3://b/manifest minus s3://b/done/', 'http-200: https://…', or 'shell: &lt;cmd&gt;' (shell = local daemon only). When true the fleet retires. |

