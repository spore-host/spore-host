---
description: "This tutorial walks through the complete workflow for discovering and evaluating EC2 instance types before launching — using truffle find, truffle spot, and truffle quotas in sequence."
---

# Finding the Right Instance

This tutorial walks through the complete workflow for discovering and evaluating EC2 instance types before launching — using `truffle find`, `truffle spot`, and `truffle quotas` in sequence.

## The workflow

```
truffle find    →  discover the instance family
truffle find    →  browse its sizes and filter by specs
truffle spot    →  check current Spot prices
truffle quotas  →  verify you have headroom
spawn launch    →  launch with confidence
```

Each step is a separate sub-command. `truffle find` takes specs in the query string (`"m8a 16 cores 64gb"`); it has no `--min-vcpu` or `--min-memory` flags.

---

## Example: AMD EPYC instances

### Step 1 — Discover the family with `truffle find`

Use plain language to discover which instance families match a processor or capability:

```sh
truffle find "amd turin"
```

`find` searches your configured region (here `us-east-1`). Add `--all-regions` to search every enabled region, or `--regions` to pick some.

Output (abbreviated, some columns omitted):
```
Found 48 instance types across 1 region(s)

┌───────────────┬───────────┬───────┬──────────────┬──────────────┐
│ Instance Type │ Region    │ vCPUs │ Memory (GiB) │ Architecture │
├───────────────┼───────────┼───────┼──────────────┼──────────────┤
│ m8a.medium    │ us-east-1 │ 1     │ 4.0          │ x86_64       │
│ m8a.large     │ us-east-1 │ 2     │ 8.0          │ x86_64       │
│ c8a.xlarge    │ us-east-1 │ 4     │ 8.0          │ x86_64       │
│ r8a.xlarge    │ us-east-1 │ 4     │ 32.0         │ x86_64       │
│ m8a.4xlarge   │ us-east-1 │ 16    │ 64.0         │ x86_64       │
...
```

You can see the EPYC Turin (5th gen) families, such as `m8a`, `c8a`, and `r8a`; `truffle find "amd genoa"` lists the 4th-gen ones (`m7a`, `c7a`, `r7a`, `hpc7a`). A long result can be cut short with `--limit N`, which lists the first N instance types and, unlike `| head`, keeps the table's border and footer.

To include spec requirements, put them in the query string:

```sh
truffle find "amd turin 16 cores"
truffle find "amd turin 64gb"
```

Use `amd` for the vendor. `epyc` is not in truffle's vocabulary, so it is ignored, with a note. See `truffle find --help` for the words it understands.

::: tip Specs go in the query
`truffle find` does not accept `--min-vcpu` or `--min-memory`. Include specs in the query string instead. They are minimums; add `--exact` to match them exactly.
:::

---

### Step 2 — Browse sizes with `truffle find`

Once you know the family, name it in the query with your spec. This lists the `m8a` sizes with at least 16 vCPUs and 64 GiB of memory:

```sh
truffle find "m8a 16 cores 64gb" --skip-azs
```

Output (abbreviated, some columns omitted):
```
Found 8 instance types across 1 region(s)

┌───────────────┬───────────┬───────┬──────────────┬──────────────┐
│ Instance Type │ Region    │ vCPUs │ Memory (GiB) │ Architecture │
├───────────────┼───────────┼───────┼──────────────┼──────────────┤
│ m8a.4xlarge   │ us-east-1 │ 16    │ 64.0         │ x86_64       │
│ m8a.8xlarge   │ us-east-1 │ 32    │ 128.0        │ x86_64       │
│ m8a.12xlarge  │ us-east-1 │ 48    │ 192.0        │ x86_64       │
...
```

To list every size in the family instead, use a pattern: `truffle find "m8a.*"` (or just `truffle find m8a`).

Useful `truffle find` options:
- `16 cores` / `16 physical cores` in the query — minimum vCPUs / physical cores
- `64gb` in the query — minimum memory in GiB
- `arm64` / `x86_64` in the query — CPU architecture
- `--exact` — match the vCPU and memory in the query exactly
- `--show-price` — add on-demand pricing to pattern queries (plain-language results include it already)
- `--limit N` — list only the first N instance types
- `--pick-first` — output only the top result (for scripting)

---

### Step 3 — Check Spot prices with `truffle spot`

Before committing, check current Spot prices. Spot can be 60–90% cheaper than on-demand:

```sh
truffle spot m8a.4xlarge --sort-by-price --active-only
```

`truffle spot` searches every enabled region and always shows the On-Demand price and the saving (On-Demand rates come from the live AWS Price List). For a long list, `--limit N` shows only the first N rows. Output:
```
┌───────────────┬───────────┬───────────────────┬───────────────┬───────────┬─────────┐
│ Instance Type │ Region    │ Availability Zone │ Spot Price/hr │ On-Demand │ Savings │
├───────────────┼───────────┼───────────────────┼───────────────┼───────────┼─────────┤
│ m8a.4xlarge   │ us-east-1 │ us-east-1a        │ $0.0812       │ $0.7750   │ 89%     │
│               │ us-east-1 │ us-east-1c        │ $0.0834       │ $0.7750   │ 89%     │
│               │ us-west-2 │ us-west-2b        │ $0.0901       │ $0.7750   │ 88%     │
```

To compare specific regions only, add `--regions`:
```sh
truffle spot m8a.4xlarge --regions us-east-1,us-east-2,eu-west-1 --sort-by-price
```

---

### Step 4 — Check your quota with `truffle quotas`

Every AWS account has vCPU quotas per instance family. `m8a` is in the **Standard** family (the same quota as other M, C, R, and T instances):

```sh
truffle quotas --family Standard --regions us-east-1
```

Output:
```
┌──────────┬───────────┬────────────┬───────────┬────────────┬────────┐
│ Family   │ Type      │ Quota      │ In Use    │ Available  │ Status │
├──────────┼───────────┼────────────┼───────────┼────────────┼────────┤
│ Standard │ On-Demand │ 1480 vCPUs │ 153 vCPUs │ 1327 vCPUs │ ✅ OK  │
│ Standard │ Spot      │ 640 vCPUs  │ -         │ 640 vCPUs  │ ✅ OK  │
```

An `m8a.4xlarge` has 16 vCPUs. With 1327 available, you can run up to ~82 simultaneous on-demand instances before hitting quota.

If you're near the limit, generate a quota increase request:
```sh
truffle quotas --family Standard --regions us-east-1 --request
```

---

### Step 5 — Launch

```sh
spawn launch my-job \
  --instance-type m8a.4xlarge \
  --region us-east-1 \
  --spot \
  --ttl 4h
```

Or use `--pick-first` to pipe directly from `truffle find`:
```sh
spawn launch my-job \
  --instance-type $(truffle find "m8a 16 cores 64gb" --pick-first) \
  --spot \
  --ttl 4h
```

---

## GPU example: NVIDIA H100

The same workflow applies for specialized instances:

```sh
# 1. Find H100 instances
truffle find "h100 efa"

# 2. Browse p5 sizes (H100 is in p5 family)
truffle find "p5.*" --skip-azs

# 3. Check Spot prices (p5 is rarely Spot — check on-demand)
truffle spot p5.48xlarge --regions us-east-1,us-west-2

# 4. Check P-family quota (separate from Standard)
truffle quotas --family P --regions us-east-1

# 5. Launch (p5 typically on-demand, not Spot)
spawn launch gpu-job --instance-type p5.48xlarge --ttl 24h
```

---

## Quick reference: which command for what

| Task | Command |
|------|---------|
| "What instances have H100 GPUs?" | `truffle find "h100"` |
| "What are all c7a sizes?" | `truffle find "c7a.*"` |
| "c7a instances with ≥32 vCPUs" | `truffle find "c7a 32 cores"` |
| "Current Spot price for g5.xlarge" | `truffle spot g5.xlarge` |
| "Do I have quota for more G instances?" | `truffle quotas --family G` |
| "Check capacity reservations" | `truffle capacity --gpu-only` |

## See also

- [Spot Instances guide](/guides/spot-instances) — handling interruptions, diversifying instance types
- [truffle command reference](/tools/reference/truffle) — all flags for every sub-command
