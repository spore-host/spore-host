<p align="center">
  <img src="docs/brand/spore-host-hero.png" alt="spore.host — Infrastructure that grows with your research" width="820">
</p>

<p align="center">
  <a href="https://github.com/spore-host/spore-host/actions/workflows/ci.yml"><img src="https://github.com/spore-host/spore-host/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://codecov.io/gh/spore-host/spore-host"><img src="https://codecov.io/gh/spore-host/spore-host/branch/main/graph/badge.svg" alt="codecov"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0"></a>
  <a href="https://docs.spore.host"><img src="https://img.shields.io/badge/docs-docs.spore.host-blue" alt="Documentation"></a>
  <a href="https://doi.org/10.5281/zenodo.21439339"><img src="https://zenodo.org/badge/DOI/10.5281/zenodo.21439339.svg" alt="DOI"></a>
</p>

**spore.host** is a suite of tools for launching and managing AWS EC2 instances (Linux **and Windows**) — with automatic lifecycle management so instances clean up after themselves.

This repository (`spore-host/spore-host`) holds the **shared infrastructure** behind spore.host: the hosted REST API, the dashboard, deployment automation, AMI builds, and the documentation site. **The CLI tools and SDKs each live in their own repository** (see below) — the Python SDK is published from [spore-host/python-sdk](https://github.com/spore-host/python-sdk).

---

## The tools

Each tool is developed and released independently:

| Tool | Repo | What it does |
|------|------|--------------|
| 🔍 **truffle** | [spore-host/truffle](https://github.com/spore-host/truffle) | Find capacity, compare spot prices, check quotas |
| 🚀 **spawn** | [spore-host/spawn](https://github.com/spore-host/spawn) | Launch and manage Linux & Windows instances (build a Windows AMI from an ISO; connect via SSH, RDP, or SSM; includes the `spored` lifecycle daemon) |
| 👁️ **lagotto** | [spore-host/lagotto](https://github.com/spore-host/lagotto) | Watch for EC2 capacity and act when it appears |
| 🤖 **spore-host-mcp** | [spore-host/spore-host-mcp](https://github.com/spore-host/spore-host-mcp) | AI assistant integration (Claude, Cursor) |
| 🧩 **spore-plugins** | [spore-host/spore-plugins](https://github.com/spore-host/spore-plugins) | Official plugin registry for spawn |
| 🐍 **python-sdk** | [spore-host/python-sdk](https://github.com/spore-host/python-sdk) | Python SDK (`pip install spore-host`) for notebooks and scripts |
| 🧬 **nf-spawn** | [spore-host/nf-spawn](https://github.com/spore-host/nf-spawn) | Nextflow executor plugin — run pipeline steps on ephemeral instances |
| 📚 **libs** | [spore-host/libs](https://github.com/spore-host/libs) | Shared Go libraries (i18n, catalog, pricing) |

## Install the tools

**macOS / Linux (Homebrew)**

```bash
brew install spore-host/tap/truffle
brew install spore-host/tap/spawn
brew install spore-host/tap/lagotto
```

**Windows (Scoop)**

```powershell
scoop bucket add spore-host https://github.com/spore-host/scoop-bucket
scoop install truffle spawn lagotto
```

See each tool's repo for `.deb`/`.rpm` packages and direct downloads.

## Quick Start

```bash
# Find the cheapest spot instance across regions
truffle spot c6a.xlarge c7g.xlarge --sort-by-price --active-only

# Launch with a name — gets DNS at my-job.<account>.spore.host automatically
spawn launch my-job --instance-type c6a.xlarge --ttl 4h --on-complete terminate

# Connect by name (auto-starts if stopped)
spawn connect my-job

# Watch for scarce GPU capacity and auto-launch when it appears
lagotto watch "p5.48xlarge" --action spawn --spawn-config training.yaml --ttl 7d
```

**Windows, too** — turn a Windows 11 ISO into a fast-booting AMI, launch it, and connect by RDP or SSH:

```bash
spawn image import --iso Win11_Enterprise.iso --name win11   # ISO → AMI (auto-warmed)
spawn launch winbox --ami <ami-id> --os windows --ttl 4h
spawn connect winbox --rdp        # graphical desktop  (or --ssh, or a PowerShell-over-SSM shell)
```

See the [Windows beta guide](https://github.com/spore-host/spawn/blob/main/docs/windows-beta-guide.md) for the full walkthrough.

Full usage at **[docs.spore.host](https://docs.spore.host)**.

---

## What's in this repository

```
spore-host/
├── lambda/
│   └── rest-api/    # Hosted REST API Lambda (instance management + SMS webhook)
├── web/             # Dashboard static assets (dashboard.html, library.html, …)
├── infra/           # AMI builds, TLS certs, infrastructure deployment guide
├── scripts/         # Deployment & setup automation (Cognito, API Gateway, DynamoDB, S3, IAM)
├── config/          # OAuth credentials (gitignored secrets)
├── examples/        # Multi-region example configs
└── docs/            # VitePress documentation site (docs.spore.host) — covers all tools
```

The hosted API (`lambda/rest-api`) imports the published tool modules
(`github.com/spore-host/spawn`, `github.com/spore-host/truffle`) as versioned
dependencies — it is the only Go module in this repository.

---

## Architecture

spore.host runs across separate AWS accounts:

- **Infrastructure account** — S3 buckets (`spawn-binaries-*`, dashboard, website), the `spawn-dns-updater` and `rest-api` Lambdas, Route53 (`spore.host` zone), CloudFront, Cognito.
- **Compute account** — all EC2 instance provisioning. Instances pull the `spored` daemon from regional S3 buckets and register DNS via the infrastructure account's Lambda.

See [infra/DEPLOY.md](infra/DEPLOY.md) and [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for the full deployment walkthrough.

---

## Documentation

Full documentation at **[docs.spore.host](https://docs.spore.host)** or in the `docs/` directory.

- [Quick Start](docs/quickstart.md)
- [Finding the Right Instance](docs/guides/finding-instances.md)
- [truffle reference](docs/tools/truffle.md)
- [spawn reference](docs/tools/spawn.md)
- [lagotto reference](docs/tools/lagotto.md)
- [Batch Queues](docs/guides/batch-queue.md)
- [Nextflow (nf-spawn)](docs/guides/nextflow.md)
- [Self-Hosting](docs/guides/self-hosting.md)
- [IAM Permissions](docs/reference/iam-permissions.md)

---

## Citation

If you use spore.host in your research, please cite it. The concept DOI below
always resolves to the latest release; see [`CITATION.cff`](CITATION.cff) for
full metadata (GitHub's "Cite this repository" renders it for you).

> Friedman, S. spore.host: ephemeral AWS compute for researchers. https://doi.org/10.5281/zenodo.21439339

## License

Apache 2.0 — Copyright 2025-2026 Scott Friedman. See [LICENSE](LICENSE).
