---
description: "Definitions of the core spore.host terms — and the one canonical noun for a managed machine."
---

# Glossary

spore.host's names are deliberately close (spore, spawn, spored, spore-bot), which
makes the family cohere but can blur which word means what. This page fixes the
vocabulary.

## The canonical noun

**instance** — the canonical word for a machine spore.host manages. When you need
to disambiguate from a raw EC2 instance you launched some other way, say
**spore.host-managed instance** (or *managed instance*). Prefer "instance"
throughout; avoid using "spore" as a noun for a machine.

## Tools

| Term | What it is |
|------|-----------|
| **spore.host** | The project and the toolkit as a whole. Also the domain. Not a hosted service — see [Security, credentials & data flow](/architecture). |
| **truffle** | The discovery CLI: find instance types, compare prices, check quotas. Read-only. |
| **spawn** | The launcher CLI: launches instances and provisions spored onto them; manages their lifecycle from your laptop. |
| **spored** | The lifecycle *daemon* that runs on each launched instance and enforces its rules from the inside. You never install it — spawn provisions it. |
| **spore-bot** | The Slack/Teams integration for controlling instances from chat. |
| **lagotto** | The capacity watcher: waits for scarce capacity and notifies or launches when it appears. |
| **spore-host-mcp** | The MCP server exposing truffle and spawn to AI assistants. |

## Lifecycle concepts

| Term | Definition |
|------|-----------|
| **TTL** (time to live) | The absolute deadline, set once at launch, at which the instance terminates. It never resets across stop/wake cycles; only `spawn extend` moves it, and only forward. The hard backstop. See [Costs & safety guarantees](/safety). |
| **idle timeout** | A *soft* rule: stop or hibernate after a period with no activity. Any activity resets it. Idle never terminates — it only stops/hibernates. Not the same as the TTL. |
| **completion signal** | An explicit "my work is done" marker — a sentinel file (default `/tmp/SPAWN_COMPLETE`) or `spored complete`. Triggers the configured `on-complete` action. |
| **completion sentinel** | The file spored watches for the completion signal. Its *appearance* — not your command merely finishing — is what triggers the action. |
| **pre-stop hook** | A shell command spored runs before any lifecycle-triggered stop or terminate, to save work (e.g. `aws s3 sync /results s3://…`). |
| **cost limit** | An optional **compute + EBS** spend ceiling (instance rate × total compute time, carried across stop/resume, plus EBS × wall-clock time); spored terminates when it's crossed. Independent of the TTL — first ceiling to fire wins. |
| **reaper** | The out-of-band backstop that terminates managed instances past their TTL even if spored is unhealthy. See [Costs & safety guarantees](/safety). |

## Compute-shape concepts

| Term | Definition |
|------|-----------|
| **job array** | A group of related instances launched and managed together. See [Job arrays](/guides/job-arrays). |
| **parameter sweep** | Running the same job across many parameter combinations in parallel. See [Parameter sweeps](/guides/parameter-sweeps). |
| **MPI cluster** | Multiple tightly-coupled nodes launched together for distributed workloads. See [MPI clusters](/guides/mpi). |
| **Capacity Block for ML** | A pre-purchased, time-boxed reservation of scarce GPU capacity. Launch into it at its start time with `lagotto launch --at`. See [Lagotto](/tools/lagotto#capacity-blocks-for-ml). |
| **watch** | A Lagotto request to wait for capacity for a given instance type and act (notify/spawn/hold) when it appears. |

## Common confusions

For the pitfalls these terms cause — TTL vs idle timeout, `find` vs `search`,
region vs AZ, quota vs actual capacity, stop vs hibernate vs terminate, a command
finishing vs the completion sentinel appearing — see
[Troubleshooting & common mistakes](/reference/troubleshooting).
