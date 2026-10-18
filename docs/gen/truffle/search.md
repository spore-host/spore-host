## `truffle search`

> **Deprecated:** use 'find' instead — it auto-detects patterns vs natural language queries

Search for instance types by pattern.

Searches your configured region by default (spore config region, AWS_REGION /
AWS_DEFAULT_REGION, or the profile's region), like find. Use --regions to choose
regions, or --all-regions to search every enabled region. With no region
configured, search covers every enabled region.

Supports glob patterns (m7i*, c7?) and regex (c[6-8]i\.large, (p4d|p5)\..*) for flexible matching.

```
truffle search [instance-type-pattern] [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--all-regions` |  | bool |  | Search every enabled region (default: only your configured region, e.g. AWS_REGION or the profile's region) |
| `--architecture` |  | string |  | Filter by architecture (x86_64, arm64, i386) |
| `--family` |  | string |  | Filter by instance family (e.g., m5, c5) |
| `--min-memory` |  | float64 |  | Minimum memory in GiB |
| `--min-vcpu` |  | int |  | Minimum number of vCPUs |
| `--nested-virtualization` |  | bool |  | Only types supporting nested virtualization (KVM/Hyper-V in-instance) |
| `--pick-first` |  | bool |  | Output only the top result's instance type (useful for piping to spawn) |
| `--price-unit` |  | string | `hour` | Price display unit for --show-price: hour, minute, or second |
| `--service` |  | string | `ec2` | Instance namespace to search: ec2 or sagemaker (ml.* types) |
| `--show-gpu-ratios` |  | bool |  | Add vCPU/GPU and RAM/GPU columns for GPU instance types (decisive for CPU/IO-bound ML workloads) |
| `--show-mem-per-cpu` |  | bool |  | Show memory per physical core alongside total memory |
| `--show-price` |  | bool |  | Show on-demand pricing (uses static pricing data) |
| `--show-quota` |  | bool |  | Show the per-type training-job quota (SageMaker only) |
| `--show-real-cores` |  | bool |  | Show physical CPU core count alongside vCPUs (format: vCPU/CPU, e.g. 96/48) |
| `--skip-azs` |  | bool |  | Skip availability zone lookup (faster but less detailed) |
| `--timeout` |  | duration | `5m0s` | Timeout for AWS API calls |

