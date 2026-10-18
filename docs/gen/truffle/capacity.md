## `truffle capacity`

Check ML capacity reservations across AWS regions.

Supports both Capacity Blocks (training workloads) and On-Demand Capacity
Reservations (ODCRs) for GPU and ML instances.

Examples:
  # Check all reservations
  truffle capacity

  # GPU instances only
  truffle capacity --gpu-only

  # Capacity Blocks for ML
  truffle capacity --blocks

  # Available capacity only
  truffle capacity --available-only

```
truffle capacity [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--active-only` |  | bool | `true` | Only show active reservations (default: true) |
| `--all-regions` |  | bool |  | Search every enabled region (already the default here; useful to be explicit in scripts). Cannot be combined with --regions |
| `--available-only` |  | bool |  | Only show reservations with available capacity |
| `--blocks` |  | bool |  | Show Capacity Blocks for ML (training workloads) |
| `--gpu-only` |  | bool |  | Only show GPU/ML instance reservations |
| `--instance-types` |  | stringSlice |  | Filter by instance types (comma-separated) |
| `--min-capacity` |  | int |  | Minimum available capacity |
| `--timeout` |  | duration | `5m0s` | Timeout for AWS API calls |

