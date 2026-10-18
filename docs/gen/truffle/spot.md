## `truffle spot`

Search for Spot instance pricing and availability across AWS regions.

Shows current Spot prices, savings vs On-Demand, and price history.

Examples:
  # Spot prices for m7i.large
  truffle spot m7i.large

  # Filter by max price
  truffle spot "m7i.*" --max-price 0.10

  # Sort by price
  truffle spot "c7.*" --sort-by-price

```
truffle spot <instance-type-pattern>... [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--active-only` |  | bool |  | Only show AZs with active Spot capacity |
| `--all-regions` |  | bool |  | Search every enabled region (already the default here; useful to be explicit in scripts). Cannot be combined with --regions |
| `--limit` |  | int |  | List only the first N rows, in result order (0 = all). The table keeps its border and footer, unlike \| head |
| `--local-zones` |  | bool |  | Include local zones in results (excluded by default) |
| `--lookback-hours` |  | int | `1` | Hours to look back for price history (1-720) |
| `--max-price` |  | float64 |  | Maximum Spot price per hour (USD) |
| `--pick-first` |  | bool |  | Output only the top result's instance type (useful for piping to spawn) |
| `--sort-by-price` |  | bool |  | Sort by price (cheapest first) |
| `--timeout` |  | duration | `5m0s` | Timeout for AWS API calls |

