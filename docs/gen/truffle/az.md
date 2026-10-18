## `truffle az`

Search for instance types with an availability zone-first perspective.
This command prioritizes showing which specific AZs support each instance type,
making it ideal for multi-AZ deployments and capacity planning.

Searches every enabled region by default, since the point is to compare
regions; use --regions (or --az, which implies its zones' regions) to narrow.

Examples:
  # Find which AZs have m7i.large
  truffle az m7i.large

  # Search in specific AZs only
  truffle az m7i.large --az us-east-1a,us-east-1b

  # Find instances available in at least 3 AZs per region
  truffle az "m8g.*" --min-az-count 3

  # Just the regions that offer m7i.large in at least 3 AZs
  truffle az m7i.large --min-az-count 3 --regions-only

  # Show AZ availability summary
  truffle az "c7i.xlarge" --output json

```
truffle az [instance-type-pattern] [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--all-regions` |  | bool |  | Search every enabled region (already the default here; useful to be explicit in scripts). Cannot be combined with --regions |
| `--az` |  | stringSlice |  | Filter by specific availability zones (e.g., us-east-1a,us-west-2b) |
| `--local-zones` |  | bool |  | Restrict results to Local Zones and Wavelength Zones (edge locations) |
| `--min-az-count` |  | int |  | Minimum number of AZs required per region |
| `--regions-only` |  | bool |  | Show only the regions that meet the AZ requirement (--min-az-count): one row per region with its AZ count, AZs and matching types, instead of one per instance type |
| `--timeout` |  | duration | `5m0s` | Timeout for AWS API calls |

