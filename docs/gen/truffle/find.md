## `truffle find`

Find EC2 instance types using natural language, glob patterns, or regex.

Searches your configured region by default (spore config region, AWS_REGION /
AWS_DEFAULT_REGION, or the profile's region). Use --regions to choose regions,
or --all-regions to search every enabled region. With no region configured,
find searches every enabled region.

Auto-detects query type:
  - Patterns: m7i*, c[6-8]i.large, g5.* → pattern matching
  - Natural language: "graviton 8 cores 32gb" → spec-based search
  - Multiple explicit types as separate args compare side-by-side in one
    table: truffle find g5.2xlarge g5.4xlarge g5.12xlarge

Understands:
  - CPU vendors: intel, amd, graviton, nvidia
  - Processors: emerald rapids, sapphire rapids, ice lake, turin, genoa, milan,
    rome, naples (and zen 1 to zen 5)
  - GPUs: h200, h100, a100, b200, b300, l40s, l4, a10g, t4, rtx, inferentia, trainium
  - Any accelerator: gpu, gpus, accelerator, accelerators (every GPU,
    Inferentia, Trainium, FPGA and media-accelerator family; "amd gpu" is the
    GPU hosts with an AMD CPU, e.g. g5 and g6, and "graviton gpu" is g5g)
  - Accelerator use case: training (H100, H200, A100, V100, B200, B300,
    Trainium, Trainium2) or inference (A10G, T4, L4, L40S, Inferentia,
    Inferentia2), as AWS positions each chip; name a GPU to get one outside
    its usual use case
    (hyphenated/suffixed spec strings also work, e.g. "RTX-PRO-6000",
    "A100-80GB", "H100!", "B200+" — Modal's documented GPU naming convention)
  - Instruction sets: avx2, avx-512, sve, sve2
  - NVIDIA MIG: mig (matches only GPUs supporting Multi-Instance GPU
    partitioning — A100, H100, H200, B200, RTX PRO 6000/4500; NOT
    L4/L40S/T4/A10G/V100/B300)
  - NVIDIA MPS: mps (matches ANY NVIDIA GPU — MPS is a CUDA runtime feature,
    not a hardware capability tied to instance type, unlike MIG above)
  - Specs: 8 cores, 8 physical cores, 32gb, 4 gpus
    (minimums: results are listed closest fit first, then cheapest — the
    request's exact size leads; add --exact to show only exact matches)
  - Memory: a bare size is host memory ("amd 16 cores 64gb"), except in a
    GPU or accelerator query, where it is the memory of each GPU.
    Host memory is in GiB ("64gb" and "64gib" both mean 64 GiB), as the
    Memory (GiB) column shows it. Per-GPU memory is the size the GPU is
    sold as, in its own unit: GiB for most (H100 80 GiB, B200 179 GiB),
    GB for some (A10G and L4 24 GB, L40S 48 GB), so "gpu 24gb" is A10G,
    L4 and larger, not the 16 GiB T4.
    Say which you mean with "64gb ram" / "64gb memory" (host) or
    "24gb vram" / "24gb gpu memory" (per GPU); "a10g 24gb 64gb ram" gives
    both. find prints a note when it reads a bare size as per-GPU memory.
    The VRAM column shows the same size with its unit, so an A10G shows
    24 GB (24/gpu) and an H100 host 640 GiB (80/gpu); when Inferentia or
    Trainium rows are listed the columns read Accel / Accel mem, e.g.
    inf2.xlarge's 1 Inferentia2 is 32 GiB (32/chip) and trn2.48xlarge's
    16 Trainium2 chips 1536 GiB (96/chip).
  - Sizes: tiny, small, medium, large, huge
  - Families and exact sizes: g5, m7i-flex, xlarge, 2xlarge, metal-24xl
    ("g5 xlarge" is g5.xlarge; "g5" alone is every g5 size)
  - Architecture: x86_64, arm64
  - Network: efa, 10gbps, 25gbps, 50gbps, 100gbps, 200gbps, 400gbps
  - Sort hints: cheap/cheapest, fast/fastest, newest/latest
  - A query with no recognised word is an error that names the unknown
    words, rather than a search of every instance type
  - Combining constraints: multiple constraint types (e.g. a GPU and "efa")
    combine with AND by default — "h100 efa" means H100 instances that also
    have EFA, not "either." Add the literal word "or" anywhere in the query
    to switch the whole query to OR (union) instead; "and" is also accepted
    explicitly. Within one constraint type, multiple values still always mean
    OR — "a100 h100" always means A100-or-H100, since no instance is both.

Examples:
  truffle find g5.2xlarge g5.4xlarge g5.12xlarge (multi-type comparison)
  truffle find "m7i*"                         (glob pattern)
  truffle find "m7i*" --all-regions           (every enabled region)
  truffle find "c[6-8]i.large"                (regex pattern)
  truffle find graviton                       (vendor search)
  truffle find "turin 32 cores 64gb" --exact  (exact spec match)
  truffle find "8 physical cores 32gb"        (physical core count)
  truffle find "cheap graviton 8 cores"       (sorted by price)
  truffle find nvidia                         (all NVIDIA GPU instances)
  truffle find "gpu 24gb"                     (GPUs with at least 24 GB/GiB each)
  truffle find "a10g 64gb ram"                (A10G hosts with ≥64 GiB RAM)
  truffle find "h100 efa"                     (GPU AND network, by default)
  truffle find "h100 or efa"                  (GPU OR network, explicit)
  truffle find avx-512                        (instruction-set search)
  truffle find "sve2 graviton"                (instruction set + vendor)
  truffle find mig                            (NVIDIA MIG-capable GPUs only)
  truffle find mps                            (any NVIDIA GPU — MPS runs on all of them)

```
truffle find <query> [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--all-regions` |  | bool |  | Search every enabled region (default: only your configured region, e.g. AWS_REGION or the profile's region) |
| `--app` |  | string |  | Application name from catalog (e.g. paraview, igv) |
| `--exact` |  | bool |  | Match exact vCPU and memory values instead of minimum |
| `--limit` |  | int |  | List only the first N instance types, in result order, with every region row of each (0 = all). The table keeps its border and footer, unlike \| head |
| `--local-zones` |  | bool |  | Restrict results to Local Zones and Wavelength Zones (edge locations); mutually exclusive with --skip-azs |
| `--pick-first` |  | bool |  | Output only the top result's instance type (useful for piping to spawn) |
| `--price-unit` |  | string | `hour` | Price display unit for --show-price: hour, minute, or second |
| `--service` |  | string | `ec2` | Instance namespace to search: ec2 or sagemaker (ml.* types) |
| `--show-gpu-ratios` |  | bool |  | Add vCPU/GPU and RAM/GPU columns for GPU instance types (decisive for CPU/IO-bound ML workloads) |
| `--show-mem-per-cpu` |  | bool |  | Show memory per physical core alongside total memory |
| `--show-price` |  | bool |  | Show on-demand pricing (live AWS Price List; warns if it falls back to built-in data) |
| `--show-query` |  | bool |  | Show parsed query details |
| `--show-quota` |  | bool |  | Show the per-type training-job quota (SageMaker only) |
| `--show-real-cores` |  | bool |  | Show physical CPU core count alongside vCPUs (format: vCPU/CPU, e.g. 96/48) |
| `--skip-azs` |  | bool |  | Skip availability zone lookup (faster) |
| `--timeout` |  | duration | `5m0s` | Timeout for AWS API calls |

