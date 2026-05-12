<h1 align="center">🍄 spore.host</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0"></a>
  <a href="https://github.com/spore-host/spore-host/actions/workflows/ci.yml"><img src="https://github.com/spore-host/spore-host/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://codecov.io/gh/spore-host/spore-host"><img src="https://codecov.io/gh/spore-host/spore-host/branch/main/graph/badge.svg" alt="Coverage"></a>
  <a href="https://goreportcard.com/report/github.com/spore-host/spore-host/spawn"><img src="https://goreportcard.com/badge/github.com/spore-host/spore-host/spawn" alt="Go Report Card"></a>
  <a href="https://github.com/spore-host/spore-host/releases/latest"><img src="https://img.shields.io/github/v/release/spore-host/spore-host" alt="Latest Release"></a>
  <a href="https://img.shields.io/badge/go-1.21+-00ADD8"><img src="https://img.shields.io/badge/go-1.21+-00ADD8?logo=go" alt="Go Version"></a>
  <a href="https://snyk.io/test/github/spore-host/spore-host"><img src="https://snyk.io/test/github/spore-host/spore-host/badge.svg" alt="Known Vulnerabilities"></a>
</p>

**spore.host** is a suite of CLI tools for launching and managing AWS EC2 instances — with automatic lifecycle management so instances clean up after themselves.

- 🔍 **truffle** — Find capacity, check spot prices
- 🚀 **spawn** — Launch and manage instances
- 🤖 **spored** — Lifecycle daemon (runs on instance)

---

## Installation

**macOS / Linux (Homebrew)**

```bash
brew install spore-host/tap/truffle
brew install spore-host/tap/spawn
```

**Windows (Scoop)**

```powershell
scoop bucket add spore-host https://github.com/spore-host/scoop-bucket
scoop install truffle
scoop install spawn
```

**Debian / Ubuntu (.deb)**

```bash
curl -LO https://github.com/spore-host/spore-host/releases/latest/download/truffle_linux_amd64.deb
curl -LO https://github.com/spore-host/spore-host/releases/latest/download/spawn_linux_amd64.deb
sudo dpkg -i truffle_linux_amd64.deb spawn_linux_amd64.deb
```

**RHEL / Fedora (.rpm)**

```bash
sudo rpm -i https://github.com/spore-host/spore-host/releases/latest/download/truffle_linux_amd64.rpm
sudo rpm -i https://github.com/spore-host/spore-host/releases/latest/download/spawn_linux_amd64.rpm
```

**Direct download**

Pre-built binaries for Linux, macOS, and Windows (amd64/arm64) on the [releases page](https://github.com/spore-host/spore-host/releases/latest).

**Build from source**

```bash
git clone https://github.com/spore-host/spore-host
cd spore-host/truffle && make build && sudo make install
cd ../spawn && make build && sudo make install
```

---

## Quick Start

```bash
# Find the cheapest spot instance across regions
truffle spot c6a.xlarge c7g.xlarge --sort-by-price --active-only

# Launch with a name — gets DNS at my-job.spore.host automatically
spawn launch --name my-job --instance-type c6a.xlarge --ttl 4h --on-complete terminate

# Connect by name
spawn connect my-job

# Check status (TTL remaining, idle state)
spawn status my-job

# Extend TTL if the job is running long
spawn extend my-job 2h

# List all running instances
spawn list
```

---

## The Tools

### truffle — Find Capacity

Search instance types, compare spot prices across regions and architectures, check quotas.

**Works without AWS credentials** — credentials only needed for `truffle quotas`.

```bash
# Compare spot prices across Intel, AMD, and Graviton
truffle spot c6i.xlarge c6a.xlarge c7g.xlarge --sort-by-price --active-only

# Find GPU capacity
truffle capacity --gpu-only

# Check your account quotas
truffle quotas

# Search by spec
truffle search --min-vcpus 8 --min-memory 32 --arch arm64
```

Output formats: `--output table` (default), `--output json`, `--output yaml`, `--output csv`

[truffle documentation →](truffle/README.md)

---

### spawn — Launch and Manage

Launch EC2 instances with automatic lifecycle management. Instances terminate themselves — no forgotten bills.

**Requires AWS credentials.**

```bash
# Name your spore — sets EC2 Name tag and registers <name>.spore.host DNS
spawn launch --name my-analysis --instance-type t4g.medium

# With full lifecycle controls
spawn launch \
  --name my-job \
  --instance-type c6a.xlarge \
  --ttl 4h \
  --idle-timeout 20m \
  --on-complete terminate

# Connect, check, extend
spawn connect my-analysis          # SSH by name
spawn status my-analysis           # TTL remaining, idle state
spawn extend my-analysis 2h        # Extend TTL live
spawn list                         # All running instances

# Spot instances
spawn launch --name my-job --instance-type c6a.xlarge --spot --ttl 8h
```

**Default safety net:** if you set neither `--ttl` nor `--idle-timeout`, spawn automatically applies `--idle-timeout 1h` to prevent runaway instances.

[spawn documentation →](spawn/README.md)

---

### spored — Lifecycle Daemon

spored runs inside your instance as a systemd service. It watches for three termination triggers — whichever fires first wins:

| Trigger | How to set | What happens |
|---------|-----------|--------------|
| **Completion signal** | `touch /tmp/SPAWN_COMPLETE` | Terminates immediately (after 30s grace period) |
| **Idle timeout** | `--idle-timeout 20m` | Terminates after N minutes below CPU threshold |
| **TTL** | `--ttl 4h` | Terminates at deadline, no matter what |

Configuration is read from EC2 instance tags — no SSH required to reconfigure. Use `spawn extend` to update the TTL on a running instance.

---

## Examples

### Find cheapest capacity, then launch

```bash
# Check spot prices across instance families
truffle spot c6i.xlarge c6a.xlarge c7g.xlarge --sort-by-price --active-only

# Launch into a specific region with spot pricing
spawn launch \
  --name my-analysis \
  --instance-type c6a.xlarge \
  --region us-east-2 \
  --spot \
  --ttl 4h \
  --on-complete terminate
```

### Job with completion signal

```bash
# job.sh — runs on the instance
#!/bin/bash
python analyze.py --input data.csv --output results/
touch /tmp/SPAWN_COMPLETE   # signals spored to terminate
```

```bash
spawn launch \
  --name my-analysis \
  --instance-type t4g.medium \
  --ttl 4h \
  --on-complete terminate \
  --script job.sh
```

### Parameter sweep

```bash
spawn sweep --params grid.yaml --job-array-name my-sweep
spawn list --array my-sweep
spawn extend --job-array-name my-sweep 2h
```

### GPU instance

```bash
truffle quotas --family P          # Check P-instance quota
truffle capacity --gpu-only        # Find available GPU capacity
spawn launch --name gpu-job --instance-type g4dn.xlarge --ttl 24h
```

---

## Key Features

- **Auto-termination** — TTL, idle detection, and completion signal keep bills predictable
- **Named instances** — `--name my-job` sets an EC2 Name tag and registers `my-job.spore.host` DNS
- **Connect by name** — `spawn connect my-job` instead of hunting instance IDs
- **Live TTL extension** — `spawn extend my-job 2h` reloads config on the running instance
- **Spot-aware** — spored listens for spot interruption notices and terminates cleanly
- **Multi-arch** — Intel, AMD, and Graviton (ARM) all work out of the box
- **Cross-platform** — binaries for Linux, macOS, and Windows
- **Multilingual** — `--lang es/fr/de/ja/pt` for non-English output
- **Quota-aware** — truffle checks your service quotas before you hit a launch error

---

## AWS Credentials

spawn requires AWS credentials. truffle works without them for most commands.

```bash
# Standard AWS credential setup
aws configure

# Or environment variables
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=us-east-1
```

truffle commands that work **without** credentials: `search`, `spot`, `capacity`, `find`
truffle commands that **require** credentials: `quotas`

---

## Documentation

- [QUICK_REFERENCE.md](QUICK_REFERENCE.md) — command cheat sheet
- [spawn/README.md](spawn/README.md) — full spawn reference
- [truffle/README.md](truffle/README.md) — full truffle reference
- [spawn/PARAMETER_SWEEPS.md](spawn/PARAMETER_SWEEPS.md) — running parallel jobs
- [spawn/SPOT_INSTANCES.md](spawn/SPOT_INSTANCES.md) — spot instance guide
- [SECURITY.md](SECURITY.md) — security documentation
- [spawn/IAM_PERMISSIONS.md](spawn/IAM_PERMISSIONS.md) — required IAM permissions
- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) — enterprise deployment

---

## Project Structure

```
spore-host/
├── truffle/          # Instance discovery and quota management
│   ├── cmd/          # CLI commands (search, spot, capacity, quotas, az)
│   └── pkg/          # Core packages (aws, find, metadata, output, quotas)
└── spawn/            # Instance launching and lifecycle management
    ├── cmd/          # CLI commands (launch, connect, list, status, extend, sweep)
    └── pkg/          # Core packages (agent, aws, dns, provider, cost, ...)
```

---

## License

Apache 2.0 — Copyright 2025-2026 Scott Friedman. See [LICENSE](LICENSE).
