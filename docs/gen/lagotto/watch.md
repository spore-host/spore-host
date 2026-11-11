## `lagotto watch`

Watch for EC2 instance availability across regions and AZs.

The pattern supports wildcards: "p5.*" matches all p5 sizes, "g5.xlarge" is exact; a comma-separated list matches any of several types (e.g. "g6.xlarge,g6.2xlarge").
When capacity is found matching your criteria, the configured action is taken.

```
lagotto watch <instance-type-pattern> [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--action` |  | string | `notify` | Action on match: spawn (launch it), hold (reserve it), or notify (deprecated: offering only, not a capacity check). The notify default is deprecated too: pass --action explicitly |
| `--azs` |  | stringSlice |  | Availability zones to pin/order within the region(s), comma-separated (e.g. us-west-2b,us-west-2c). Empty = all AZs. AZ breadth is free (same-region data locality), so all AZs are tried each poll. |
| `--group-on-extra` |  | string |  | With --group: what happens to this member's launch if it lands after the group was already won: terminate (default; a hold's reservation is released) or keep |
| `--group` |  | string |  | Join (or create) a watch group: the first member to land wins and every other member is cancelled. Members may differ in pattern, regions, Spot and spawn config; --action spawn or hold only, not with --maintain, --until-landed or --service sagemaker. 'lagotto status &lt;group&gt;' and 'lagotto cancel &lt;group&gt;' act on the whole group. |
| `--maintain` |  | int |  | Goal-driven fleet: maintain this many workers (relaunching toward the goal, even from zero) until --until holds. Requires --action spawn and --regions. 0 = single-shot (default). |
| `--max-price` |  | float64 |  | Maximum acceptable price per hour (0 = any) |
| `--notify` |  | stringSlice |  | Notification channels (e.g., email:user@example.com, webhook:https://..., sns:&lt;topic-arn&gt;). An email address is subscribed to the alerts topic and must confirm by clicking the link in the AWS Notification email before anything is delivered. |
| `--project` |  | string |  | Project label for scoping a local 'poll --daemon --project' in a shared account (default: $LAGOTTO_PROJECT) |
| `--regions` | `-r` | stringSlice |  | Regions to watch (comma-separated; empty = all enabled). Widening across regions can break data co-location (cross-region egress) — prefer --azs within your data's region first. |
| `--remind` |  | string | `7d` | With --until-landed: the reminder interval (1h to 30d). You are reminded after each of the first 2 intervals and warned 24h before the pause; the watch pauses 3 × this after creation or the last ack. |
| `--require-quota` |  | bool |  | With --maintain: refuse to create the watch (exit status 3) when the account's EC2 vCPU quota, read in every --regions region, provably can't hold --maintain N workers. A quota that can't be read is unknown, not zero: the watch is then created anyway, with a note. |
| `--sagemaker-config` |  | string |  | YAML/JSON file with the SageMaker job definition (required for --service sagemaker) |
| `--service` |  | string | `ec2` | Capacity service: ec2, or sagemaker (submits your SageMaker job for ml.* types) |
| `--spawn-config` |  | string |  | lagotto spawn-config YAML (required for --action spawn; not spawn launch --config, see README for its keys — unknown keys are rejected): a local path, an s3://bucket/key URI, or '-' for stdin. Any user_data_file / iam_policy_file it references is read now and stored inline, so a hosted poller can launch it with no access to this machine. |
| `--spot` |  | bool |  | Watch for Spot capacity (default: On-Demand) |
| `--ttl` |  | string | `24h` | How long to keep watching (e.g., 24h, 7d) |
| `--until-landed` |  | bool |  | Keep hunting with no TTL until the launch (--action spawn) or hold lands. The watch pauses itself unless you run 'lagotto ack &lt;id&gt;' within (2+1) × --remind (21d by default). Needs a --notify channel; not with --ttl, --maintain, --until, or --action notify. |
| `--until` |  | string |  | Fleet completion condition, re-checked each poll: 's3-empty: s3://b/manifest minus s3://b/done/', 'http-200: https://…', or 'shell: &lt;cmd&gt;' (shell = local daemon only). When true the fleet retires. |
| `--yes` | `-y` | bool |  | Skip the confirmation prompt that --until-landed --action spawn/hold shows (required when stdin is not a terminal) |

