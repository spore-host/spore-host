---
description: "Truffle finds and compares EC2 instance types."
---

# Truffle <span class="doc-badge beginner">Beginner</span> <span class="doc-badge stable">Stable</span>

**What it is.** Truffle finds and compares EC2 instance types. It's read-only — it
never launches anything.

**When to use it.** Any time *before* a launch, to answer "what should I run and
what will it cost?" — discover a family, filter by exact specs, compare Spot
prices, and confirm your quota so a launch doesn't fail after you've waited.

**First commands:**

```sh
truffle find "amd genoa 64gb"          # discover a family in plain language
truffle find "m8a 16 cores 64gb"       # sizes in one family that meet a spec
truffle spot m8a.4xlarge               # compare Spot prices across regions
truffle quotas --regions us-east-1 --family Standard   # confirm you can launch it
truffle az p5.48xlarge                 # check per-AZ availability
```

::: tip Which command? find vs spot vs quotas
- **`find`** — you know what you need, either in plain terms ("amd genoa 64gb") or as a type name or pattern (`"m8a.*"`). Put specs in the query string; there are no `--min-vcpu` / `--min-memory` flags.
- **`spot`** — you've picked a type and want to compare Spot prices across regions and AZs.
- **`quotas`** — run immediately before launch, so you don't wait for capacity you're not allowed to use.
:::

## Install

```sh
brew install spore-host/tap/truffle
```

## AWS profile & account

Like the rest of the suite, truffle honors the shared spore.host config: a global `--profile` (and `--account` guard), the `SPORE_PROFILE`/`AWS_PROFILE` env vars, and the `[spore]` table of `~/.config/spore/config.toml`, resolved **flag > env > file > default**. An unset profile uses the ambient AWS credential chain. Region is per-request via `--regions`/`--region`. See [AWS Authentication](/guides/aws-auth) for the full model, and the [command reference](/tools/reference/truffle#global-flags) for every global flag.

## Sub-commands

Truffle has distinct sub-commands for different tasks. They are **not interchangeable** — flags available on one command may not exist on another.

### `truffle find` — plain-language, pattern, and spec search

`find` works out what kind of query you gave it. A type name or pattern (`m8a.*`, `c[6-8]i.large`, `g5.2xlarge`) is matched against instance type names. Anything else is read as plain language: processor names, GPU models, vendors, network capabilities, sizes, and specs.

```sh
truffle find "amd genoa"                # AMD EPYC Genoa (4th gen)
truffle find "h100 8 gpus efa"          # 8x NVIDIA H100 with EFA networking
truffle find "graviton large"           # ARM64 Graviton, large size class
truffle find "sapphire rapids 32 cores"
truffle find "milan 64gb"
truffle find "A100-80GB"                # only A100s with 80 GB per GPU
```

Words truffle doesn't recognise are reported as unknown and ignored, so check the spelling against `truffle find --help`. For example, write `amd` rather than `epyc`, and `8 gpus` rather than `8gpu`. A GPU memory size counts: `A100-80GB` and `a100 80gb` both match only the 80 GB A100s.

Include specs **in the query string** — `truffle find` has no `--min-vcpu` or `--min-memory` flags. Specs are minimums; add `--exact` to match them exactly:
```sh
truffle find "amd genoa 16 cores"       # ✅ at least 16 vCPUs
truffle find "m8a 16 cores 64gb"        # ✅ m8a sizes with at least 16 vCPUs and 64 GiB
truffle find "amd genoa" --min-vcpu 16  # ❌ --min-vcpu is not a find flag
```

Pattern queries match the full instance type name. Wildcards (`*`, `?`) and regular expressions work, a bare family name means every size in it, and several types side by side give one comparison table:

```sh
truffle find "m8a.*"                    # all m8a sizes
truffle find "c[6-8]i.large"            # c6i, c7i and c8i large
truffle find g5.2xlarge g5.4xlarge g5.12xlarge
```

`find` searches your configured region (spore config, `AWS_REGION` / `AWS_DEFAULT_REGION`, or the profile's region). Use `--regions` to choose regions, or `--all-regions` to search every enabled region.

Flags:
- `--regions` / `--all-regions` — choose regions, or search every enabled region
- `--skip-azs` — faster, skip AZ lookup
- `--limit N` — list only the first N instance types; unlike `| head`, the table keeps its border and footer
- `--exact` — match the vCPU and memory in the query exactly
- `--show-price` — add on-demand pricing to pattern queries (plain-language results include it already)
- `--pick-first` — print only the top result's type name
- `--app <name>` — find instances suitable for a catalog application

### `truffle spot` — current Spot prices

Get live Spot prices for a specific instance type across regions and AZs.

```sh
truffle spot m8a.4xlarge
truffle spot "m7a.*" --sort-by-price --active-only --limit 10
truffle spot g5.xlarge --regions us-east-1,us-west-2
```

`spot` searches every enabled region by default. The On-Demand price and the Spot saving are always shown. `--limit N` lists only the first N rows and keeps the table's border and footer.

### `truffle quotas` — service quota check

Check vCPU quotas before launching to avoid capacity errors.

```sh
truffle quotas --regions us-east-1
truffle quotas --family Standard --regions us-east-1   # M, C, R, T and other standard instances
truffle quotas --family P --regions us-east-1          # P-family GPU instances
truffle quotas --service sagemaker --family g5         # SageMaker ml.g5.* quotas
truffle quotas --family Standard --request             # generate increase commands
```

**Instance family codes:**

| Code | Instances |
|------|-----------|
| `Standard` | A, C, D, H, I, M, R, T, Z (general purpose) |
| `G` | g4dn, g5, g6, and vt1 (graphics/GPU; G and VT share one quota) |
| `P` | p3, p4d, p4de, p5, p6 (GPU training) |
| `Inf` | inf1, inf2 (Inferentia) |
| `Trn` | trn1, trn2 (Trainium) |
| `DL` | dl1, dl2q (Habana Gaudi, Qualcomm) |
| `F` | f1, f2 (FPGA) |
| `X` | x1, x1e, x2idn, x2iedn, x8g, and other X types (memory optimized) |

The family code is case-sensitive: `--family P` works, `--family p` matches nothing.

### `truffle capacity` — capacity reservations you own

Check existing On-Demand Capacity Reservations and Capacity Blocks **already in your account**.

```sh
truffle capacity
truffle capacity --gpu-only
truffle capacity --instance-types p5.48xlarge,p4d.24xlarge
truffle capacity --blocks                              # Capacity Blocks you already own
```

### `truffle capacity-blocks` — discover purchasable Capacity Blocks

Find purchasable [EC2 Capacity Block for ML](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/capacity-blocks.html) **offerings** — "what can I reserve?" (read-only; queries `DescribeCapacityBlockOfferings`). This is distinct from `truffle capacity --blocks`, which lists blocks you *already* own.

```sh
truffle capacity-blocks --instance-type p5.48xlarge --days 1
truffle capacity-blocks --instance-type p5.48xlarge --count 2 --days 2 \
  --region us-east-1 --start-date 2026-11-20 --sort start
```

Each offering shows its **id** (what `spawn capacity-block purchase` reserves), instance type/count, AZ, start/end, duration, and up-front price. `--instance-type` is required, plus a duration:

- `--days N` — block length in days. `--duration-hours` also works and is rounded up to a valid Capacity Block length (1-day steps to 14 days, then 7-day steps to 182).
- `--start-date YYYY-MM-DD` — blocks starting on that calendar day (UTC). `--start-after` (RFC3339) sets the earliest start instead.
- `--end-by` — latest block end time (RFC3339). By default the search covers now to the soonest a block of that length could end; blocks can start up to 8 weeks out.
- `--sort price|start` — cheapest first (the default) or soonest first.

Offerings are searched in every enabled region unless you pass `--regions`. This is step 1 of the Capacity Block flow — see [Capacity Blocks for ML](#capacity-blocks-for-ml) below.

## Typical workflow: find → spot → check quota → launch

```sh
# 1. Discover the instance family
truffle find "amd genoa"

# 2. Browse sizes within that family that meet your spec
truffle find "m8a 16 cores 64gb"

# 3. Check current Spot prices
truffle spot m8a.4xlarge --sort-by-price --active-only

# 4. Verify you have quota (m8a is Standard family)
truffle quotas --family Standard --regions us-east-1

# 5. Launch
spawn launch my-job --instance-type m8a.4xlarge --spot --ttl 4h
```

## Piping to spawn

Use `--pick-first` to get a single instance type name for piping:

```sh
spawn launch my-job \
  --instance-type $(truffle find "m8a 16 cores 64gb" --pick-first) \
  --spot --ttl 4h
```

## Capacity Blocks for ML

A Capacity Block reserves scarce GPU capacity (e.g. p5.48xlarge) for a future window. The flow spans all three tools — truffle discovers, spawn buys, lagotto launches:

```sh
# 1. truffle — find a purchasable offering (read-only)
truffle capacity-blocks --instance-type p5.48xlarge --count 1 --days 1

# 2. spawn — purchase it (billed up front, NON-REFUNDABLE; three typed
#    confirmations, interactive only; --dry-run to preview)
spawn capacity-block purchase <offering-id> --instance-type p5.48xlarge \
  --count 1 --duration-hours 24 --region us-east-1

# 3. lagotto — launch into it at the reserved start time
lagotto launch --at <block-start> --az <block-az> --spawn-config block.yaml
```

Truffle stays read-only throughout — the purchase (a real-money, non-refundable write) lives in spawn behind its confirmation gates.

## Common mistakes

- **Passing specs as flags to `find`.** Specs go *in the query* (`truffle find "m8a 16 cores 64gb"`); `find` has no `--min-vcpu` or `--min-memory`.
- **Using words truffle doesn't know.** Unrecognised words such as `epyc` or `8gpu` are ignored, so the search is broader than you meant. Use `amd` and `8 gpus`, and see `truffle find --help` for the vocabulary.
- **Expecting `find` to cover every region.** It searches your configured region; add `--all-regions` to search them all.
- **Confusing region and AZ.** A type available in a region generally can still be unplaceable in a specific AZ — use `truffle az` and pin with `--az` when it matters.
- **Assuming quota means capacity.** `truffle quotas` shows *permission* to launch, not *availability right now*. You can be within quota and still get `InsufficientInstanceCapacity` — that's what [Lagotto](/tools/lagotto) is for.

See [Troubleshooting & common mistakes](/reference/troubleshooting) for the full list.

## How it connects

Truffle is the read-only front of the workflow: it tells you *what to run*.
[Spawn](/tools/spawn) takes that and launches it (pipe with `--pick-first`, above).
When the type you want has no capacity right now, [Lagotto](/tools/lagotto) waits
for it. Truffle never launches or spends money.

## Full command reference

→ [truffle command reference](/tools/reference/truffle)
