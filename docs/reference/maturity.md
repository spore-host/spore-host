---
description: "How mature each spore.host component is, what compatibility you can rely on across releases, which platforms are supported, and how deprecations and support work."
---

# Maturity & Support Policy

spore.host is a suite of separately-versioned tools, and they are not all at the
same stage. This page states, in one place, **how mature each piece is, what
compatibility you can rely on, which platforms are supported, and how we handle
deprecations** — so you can decide what to build on and what to pin.

## Maturity levels

| Badge | Meaning |
|-------|---------|
| <span class="doc-badge stable">Stable</span> | Interface is settled and actively supported. Changes are additive or follow the deprecation process below. **Not the same as 1.0/GA** — see [Versioning](#versioning-what-you-can-rely-on). |
| <span class="doc-badge beta">Beta</span> | Usable and supported, but the interface may still change with notice. |
| <span class="doc-badge experimental">Experimental</span> | Early / prototype. May change or break without a deprecation window. Validate against your own workload before relying on it. |
| <span class="doc-badge planned">Planned</span> | On the roadmap, not built yet. |

## Component status

The **six core tools are Stable**: their commands and flags are settled and we
maintain them actively. They are all still **pre-1.0** (`v0.x`) — see
[Versioning](#versioning-what-you-can-rely-on) for exactly what that means for
breaking changes.

| Component | Status | Latest | Notes |
|-----------|--------|--------|-------|
| **truffle** | <span class="doc-badge stable">Stable</span> | v0.46.0 | Instance discovery, quotas, spot/capacity search (read-only). |
| **spawn** | <span class="doc-badge stable">Stable</span> | v0.91.x | Launch + full lifecycle management. |
| **spored** | <span class="doc-badge stable">Stable</span> | ships with spawn | In-instance lifecycle daemon; built and released with spawn. |
| **lagotto** | <span class="doc-badge stable">Stable</span> | v0.50.0 | Capacity watcher. |
| **spore-bot** | <span class="doc-badge stable">Stable</span> | continuous | Slack/Teams control. Deployed continuously (not tag-released). |
| **MCP server** | <span class="doc-badge stable">Stable</span> | v0.36.x | Read/manage tools for AI assistants — [no launch, by design](/tools/mcp-server). |
| **Plugin registry** | <span class="doc-badge stable">Stable</span> | per-plugin | Each plugin is versioned independently in its `plugin.yaml`; official plugins are [signature-verified](/guides/plugins). |

### Beta and experimental surfaces

Some capabilities inside otherwise-Stable tools are less settled. These are called
out where they appear in the docs; the list below is the canonical index.

| Surface | Status | Where |
|---------|--------|-------|
| **Application streaming** (`spawn app` — DCV GUI apps + web-UI apps) | <span class="doc-badge beta">Beta</span> | Launch a research app (ParaView, ChimeraX, …) streamed over Amazon DCV, or a web-UI app (Jupyter, code-server) behind a TLS proxy. Shipped in spawn v0.107.0; the container catalog and its interface may still change. See [Jupyter on spawn](/guides/jupyter). |
| **HTTP API + Python SDK** | <span class="doc-badge beta">Beta</span> | The SDK is the supported entry point; the underlying HTTP API may change. See [Python SDK](/guides/python-sdk). |
| **Workflow adapters** (Nextflow, WDL, CWL, Snakemake, Airflow) | <span class="doc-badge experimental">Experimental</span> | All five are early — two pre-1.0 prototypes and three `v0.1.0` initial releases. Read the [status & compatibility matrix](/guides/workflow-engines) before relying on one. |
| **Pipeline stage streaming** (tcp/grpc/zmq) | <span class="doc-badge experimental">Experimental</span> | Operationally involved; prefer the S3 handoff. See [Spawn pipelines](/guides/pipelines#streaming-between-stages). |
| **Per-event notification filtering** | <span class="doc-badge planned">Planned</span> | See [Lifecycle Notifications](/guides/notifications). |

If a page and this table ever disagree, the more conservative (less mature) label
wins — please [report it](https://github.com/spore-host/spore-host/issues/new/choose).

## Versioning — what you can rely on

Every spore.host tool follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)
and keeps a [Keep a Changelog](https://keepachangelog.com/)-format `CHANGELOG.md`.
User-facing changes land in the changelog in the same change that makes them.

**All tools are currently pre-1.0 (`v0.x`).** Under SemVer's pre-1.0 rules, that
changes what a version bump means:

| Bump | Pre-1.0 meaning (today) | Post-1.0 meaning (future) |
|------|-------------------------|---------------------------|
| **MAJOR** (`X`) | — (still 0) | Breaking change |
| **MINOR** (`0.Y`) | **Breaking changes *or* new features** | Backward-compatible feature |
| **PATCH** (`0.0.Z`) | Backward-compatible fix | Backward-compatible fix |

**The practical rule while we're pre-1.0: a breaking change bumps the MINOR
version.** So if you depend on exact CLI behavior in automation, **pin to a MINOR
series** (e.g. `spawn 0.91.x`) and read the changelog's `Changed`/`Removed`/
`Deprecated` sections before moving to a new minor.

- **Plugins** version independently — each plugin's `version:` in its `plugin.yaml`
  follows SemVer per plugin (a breaking change to a plugin's inputs/behavior bumps
  its version). The registry itself is not versioned as a whole.
- **Go library consumers** (e.g. importing truffle as a package): a breaking
  exported-signature change is treated as a breaking bump (pre-1.0 ⇒ MINOR).

## Platform support

### Where the CLIs run

The `truffle`, `spawn`, and `lagotto` binaries are published for:

| OS | amd64 | arm64 |
|----|:---:|:---:|
| **macOS** | ✅ | ✅ |
| **Linux** | ✅ | ✅ |
| **Windows** | ✅ | ✅ |

Install via [Homebrew, Scoop, `.deb`/`.rpm`, or a manual download](/quickstart#install).
On Windows, run the CLIs under WSL2 for the smoothest experience.

### What spawn can launch

- **Linux instances** — Amazon Linux 2023 (the auto-selected default), Amazon
  Linux 2, and Ubuntu AMIs. spored installs via user-data at launch.
- **Windows instances** — supported via SSM-first launch and connect, with spored
  running as a native Windows service. (The headless launcher path used by lagotto
  is Linux-only.)
- **GPU** — spawn auto-selects a GPU AMI for GPU instance types; truffle discovers
  GPU families and their price/quotas. See [GPU training](/guides/gpu-training).
- **EFA / MPI** — `--efa` enables Elastic Fabric Adapter on supported instance
  types with an auto-configured security group and cluster placement group. See
  [MPI clusters](/guides/mpi).

## Deprecation & support

We remove things carefully and telegraph it:

1. **Deprecations are announced in the changelog** under a `Deprecated` heading in
   the release that introduces them, and the CLI itself prints a deprecation notice
   when you use the old form.
2. **The old form keeps working as an alias** for a transition period rather than
   breaking immediately — for example `truffle search` now points to
   `truffle find`, and several `spawn` subcommands moved under `spawn ami …` and
   `spawn sweep …` while the old names still run.
3. **Removal happens in a later MINOR release** (pre-1.0), and is listed under
   `Removed` in that release's changelog. Pinning to a MINOR series (above) means a
   removal never surprises you.

We do not yet publish a fixed end-of-life schedule (e.g. "supported for N
minors"). While we're pre-1.0, **the latest release of each tool is the supported
one**; fixes land on the latest and are shipped as a new PATCH or MINOR. If you
need a longer support commitment for an institutional deployment, that's a good
thing to raise in the [deployment packet](/reference/deployment-packet)
conversation with your admin — or [ask us](https://github.com/spore-host/spore-host/issues/new/choose).

## See also

- [Workflow adapters — status & compatibility matrix](/guides/workflow-engines)
- [Costs & safety guarantees](/safety)
- [FAQ](/reference/faq)
