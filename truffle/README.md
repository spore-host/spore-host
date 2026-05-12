# truffle — Find AWS EC2 Capacity

truffle searches AWS regions and availability zones for EC2 instance types, compares spot prices, and checks capacity reservations. Most commands work **without AWS credentials**.

---

## Installation

**macOS / Linux (Homebrew)**

```bash
brew install spore-host/tap/truffle
```

**Windows (Scoop)**

```powershell
scoop bucket add spore-host https://github.com/spore-host/scoop-bucket
scoop install truffle
```

**Debian / Ubuntu (.deb)**

```bash
curl -LO https://github.com/spore-host/spore-host/releases/latest/download/truffle_linux_amd64.deb
sudo dpkg -i truffle_linux_amd64.deb
```

**RHEL / Fedora (.rpm)**

```bash
sudo rpm -i https://github.com/spore-host/spore-host/releases/latest/download/truffle_linux_amd64.rpm
```

**Build from source**

```bash
git clone https://github.com/spore-host/spore-host
cd spore-host/truffle && make build && sudo make install
```

---

## Quick Start

```bash
# Search for an instance type across all regions
truffle search m7i.large

# Compare spot prices across Intel, AMD, and Graviton
truffle spot c6i.xlarge c6a.xlarge c7g.xlarge --sort-by-price --active-only

# Find GPU capacity reservations
truffle capacity --gpu-only --available-only

# Check your account quotas
truffle quotas
```

---

## Commands

### `truffle search` — Find Instance Types

Search for instance types across AWS regions. AZ details are included by default.

```bash
truffle search [pattern] [flags]
```

```bash
# Search a specific instance type
truffle search m7i.large

# Wildcard: all Graviton4 compute instances
truffle search "c8g.*"

# Filter by architecture and specs
truffle search "*.xlarge" --architecture arm64 --min-vcpu 4 --min-memory 8

# Limit to specific regions
truffle search c6a.xlarge --regions us-east-1,us-west-2

# Skip AZ lookup for faster results
truffle search m7i.large --skip-azs

# JSON output for scripting
truffle search "c7a.*" --output json | jq '.[] | select(.region == "us-east-1")'
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--skip-azs` | Skip AZ lookup (faster, region-level results only) |
| `--architecture` | Filter by architecture: `x86_64`, `arm64` |
| `--min-vcpu int` | Minimum vCPUs |
| `--min-memory float` | Minimum memory in GiB |
| `--family string` | Filter by instance family (e.g., `m7i`, `c8g`) |
| `-r, --regions strings` | Comma-separated list of regions to search |
| `-o, --output string` | Output format: `table` (default), `json`, `yaml`, `csv` |

---

### `truffle az` — Availability Zone Search

Search with AZ-level focus — useful for planning multi-AZ deployments.

```bash
truffle az [pattern] [flags]
```

```bash
# Which AZs have m7i.large?
truffle az m7i.large

# Require at least 3 AZs per region (high availability)
truffle az "m8g.*" --min-az-count 3

# Search in specific AZs only
truffle az m7i.xlarge --az us-east-1a,us-east-1b,us-east-1c
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--az strings` | Filter by specific availability zones |
| `--min-az-count int` | Minimum AZs required per region |
| `--regions-only` | Show only regions that meet the AZ count requirement |

---

### `truffle spot` — Spot Instance Pricing

Get real-time spot prices. No credentials required.

```bash
truffle spot [instance-types...] [flags]
```

```bash
# Compare spot prices across instance families
truffle spot c6i.xlarge c6a.xlarge c7g.xlarge --sort-by-price --active-only

# Find spot instances under $0.10/hour
truffle spot "m8g.*" --max-price 0.10

# Show savings vs on-demand pricing
truffle spot m7i.xlarge --show-savings

# JSON output for pipeline automation
truffle spot c6a.xlarge c7g.xlarge --sort-by-price --active-only --output json
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--max-price float` | Maximum spot price per hour (USD) |
| `--show-savings` | Show savings vs on-demand pricing |
| `--sort-by-price` | Sort by price (cheapest first) |
| `--active-only` | Only show active spot price entries |
| `--lookback-hours int` | Hours to look back for price history (default: 1) |

---

### `truffle capacity` — Capacity Reservations

Check On-Demand Capacity Reservations (ODCRs) — critical for GPU and ML instances. No credentials required.

```bash
truffle capacity [flags]
```

```bash
# Find GPU capacity reservations
truffle capacity --gpu-only

# Only show reservations with available capacity
truffle capacity --gpu-only --available-only

# Check specific instance types
truffle capacity --instance-types p5.48xlarge,g6.xlarge

# Minimum available capacity
truffle capacity --gpu-only --min-capacity 10

# Multi-region
truffle capacity --instance-types inf2.xlarge --regions us-east-1,us-west-2
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--instance-types strings` | Filter by instance types |
| `--gpu-only` | Only show GPU/ML instances (p5, g6, inf2, trn1, etc.) |
| `--available-only` | Only show reservations with available capacity |
| `--min-capacity int` | Minimum available capacity required |
| `--active-only` | Only show active reservations |

---

### `truffle quotas` — Service Quotas

Check your EC2 service quotas. **Requires AWS credentials.**

```bash
truffle quotas [flags]
```

```bash
# Check all instance quotas
truffle quotas

# Check P-instance quota (GPU)
truffle quotas --family P

# JSON output
truffle quotas --output json
```

---

## Output Formats

All commands support `--output` / `-o`:

| Format | Flag | Use case |
|--------|------|----------|
| Table | `--output table` (default) | Human reading |
| JSON | `--output json` | Scripting, jq pipelines |
| YAML | `--output yaml` | Config files, human-readable structured data |
| CSV | `--output csv` | Spreadsheet import |

```bash
# Pipeline: find cheapest region for a spot instance
truffle spot c6a.xlarge c7g.xlarge --sort-by-price --active-only --output json \
  | jq -r '.[0].region'
```

---

## Global Flags

| Flag | Description |
|------|-------------|
| `-o, --output string` | Output format: `table`, `json`, `yaml`, `csv` |
| `-r, --regions strings` | Filter by specific regions |
| `--no-color` | Disable colorized output |
| `--lang string` | Language: `en`, `es`, `fr`, `de`, `ja`, `pt` |
| `--accessibility` | Screen reader-friendly output (no emoji, no color, ASCII borders) |

---

## AWS Credentials

Most truffle commands work without credentials:

| Command | Credentials required? |
|---------|----------------------|
| `truffle search` | No |
| `truffle az` | No |
| `truffle spot` | No |
| `truffle capacity` | No |
| `truffle quotas` | **Yes** |

Standard credential setup:

```bash
aws configure
# or
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=us-east-1
```

---

## Examples

### Find cheapest spot capacity, then launch

```bash
# Check spot prices across instance families
truffle spot c6i.xlarge c6a.xlarge c7g.xlarge --sort-by-price --active-only

# Pick the cheapest region and launch
spawn launch \
  --name my-job \
  --instance-type c6a.xlarge \
  --region us-east-1 \
  --spot \
  --ttl 4h \
  --on-complete terminate
```

### GPU capacity check

```bash
# Check quota before requesting GPU
truffle quotas --family P

# Find available GPU capacity
truffle capacity --gpu-only --available-only

# Launch a GPU instance into a region with capacity
spawn launch --name gpu-job --instance-type g4dn.xlarge --ttl 24h
```

### Terraform planning

```bash
# Get all regions that support a given instance type
truffle search c5.xlarge --output json | jq -r '.[].region' | sort -u
```

---

## License

Apache 2.0 — Copyright 2025-2026 Scott Friedman. See [LICENSE](../LICENSE).
