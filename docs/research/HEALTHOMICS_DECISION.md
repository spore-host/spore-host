# AWS HealthOmics: Integration Decision

**Date:** 2026-01-27
**Issue:** #75
**Decision:** **DO NOT INTEGRATE** - Monitor as complementary service

---

## TL;DR

AWS HealthOmics is a **fully managed genomics workflow service** that competes on convenience but loses on cost (7x more expensive) and flexibility (limited workflow engines). spawn and HealthOmics serve **complementary markets** with minimal overlap.

**Recommendation:** Document HealthOmics as an alternative for production clinical workloads, but maintain spawn's focus on cost-efficient, flexible compute for research and development.

---

## Decision Matrix

| Criteria | AWS HealthOmics | spawn | Winner |
|----------|----------------|-------|--------|
| **Cost** | $3.67/run (4h, 16 vCPU) | $0.50/run (spot) | **spawn (7x cheaper)** |
| **Workflow Engines** | WDL, Nextflow, CWL only | Any (Snakemake, Cromwell, custom) | **spawn (flexibility)** |
| **Management Overhead** | Zero (fully managed) | Medium (user-managed) | HealthOmics |
| **Infrastructure Control** | None (abstracted) | Full (instance types, regions) | **spawn (control)** |
| **Compliance** | Built-in audit trails | DIY | HealthOmics |
| **Use Case Breadth** | Genomics only | General-purpose HPC | **spawn (versatility)** |
| **Vendor Lock-in** | High (proprietary storage) | Low (standard EC2/S3) | **spawn (portability)** |

---

## When to Use Each

### Use AWS HealthOmics
- ✅ Clinical diagnostic labs (HIPAA/CLIA compliance)
- ✅ Production genomics pipelines (audit trails required)
- ✅ Zero DevOps capacity (fully managed)
- ✅ Budget allows 3-7x premium for convenience
- ✅ Need population-scale variant analytics (Athena integration)

### Use spawn
- ✅ Academic research (cost-sensitive)
- ✅ Bioinformatics method development (rapid iteration)
- ✅ Snakemake workflows (not supported by HealthOmics)
- ✅ Non-genomics HPC (ML, simulations, rendering)
- ✅ Multi-cloud or on-prem portability required
- ✅ Need full infrastructure control

### Hybrid Approach
- Use **HealthOmics** for production clinical pipelines
- Use **spawn** for research, development, and exploratory analyses

---

## Integration Feasibility

### Evaluated Integration Options

**Option 1: spawn → HealthOmics Workflow Launcher**
- Add `spawn healthomics run` command to submit workflows
- **Verdict:** ❌ LOW VALUE - Users can use HealthOmics CLI directly

**Option 2: HealthOmics → spawn Compute Backend**
- Allow HealthOmics to use spawn-managed instances
- **Verdict:** ❌ NOT FEASIBLE - HealthOmics doesn't support custom compute

**Option 3: Hybrid Data Pipeline**
- spawn for preprocessing → HealthOmics for storage/analytics
- **Verdict:** ✅ DOCUMENT PATTERN - Users can implement if needed

**Option 4: EventBridge Integration**
- Trigger spawn workflows when HealthOmics completes
- **Verdict:** ✅ DOCUMENT PATTERN - Standard AWS integration

---

## Cost Comparison (30x Whole Genome Sequencing)

| Solution | Cost/Genome | Cost/1000 Genomes | Savings |
|----------|-------------|-------------------|---------|
| HealthOmics Ready2Run | $10.00 | $10,000 | Baseline |
| HealthOmics Private | $3.67 | $3,670 | 63% |
| spawn (spot) | $0.50 | $500 | **95%** |

**Break-even:** HealthOmics worth premium if DevOps cost exceeds $3,000/month

---

## Competitive Positioning

### spawn's Unique Value (vs HealthOmics)

1. **7x lower compute costs** (spot instances, auto-termination)
2. **Universal workflow support** (not limited to WDL/Nextflow/CWL)
3. **Full transparency** (no hidden managed service fees)
4. **Zero vendor lock-in** (standard AWS infrastructure)
5. **Multi-region by default** (works in all EC2 regions)
6. **General-purpose HPC** (not genomics-specific)

### Market Segmentation

| User Segment | Recommended Solution |
|--------------|---------------------|
| Clinical Diagnostics Labs | HealthOmics |
| Academic Research Labs | **spawn** |
| Pharma Drug Discovery | Hybrid |
| Agricultural Genomics | HealthOmics |
| Bioinformatics Core Facilities | **spawn** |
| Contract Research Orgs | Hybrid |

---

## Action Items

### Immediate (Week 1)
- [x] Complete HealthOmics research document
- [ ] Add documentation section: "When to Use AWS HealthOmics Instead"
- [ ] Update spawn positioning: "Cost-effective alternative to managed services"
- [ ] Comment on issue #75 with findings

### Future (Monitor)
- [ ] Watch for HealthOmics Snakemake support (reassess if added)
- [ ] Monitor HealthOmics pricing changes (reassess if drops 50%+)
- [ ] Track HealthOmics regional expansion
- [ ] Consider integration if HealthOmics allows BYO compute

### Do NOT Build
- ❌ spawn → HealthOmics API integration
- ❌ Sequence Store compatibility layer
- ❌ HealthOmics workflow converter

---

## Conclusion

AWS HealthOmics and spawn **serve different markets** and are **complementary, not competitive**. HealthOmics targets managed production genomics with compliance requirements, while spawn targets cost-efficient, flexible compute for research and development.

**spawn's value proposition remains strong** and differentiated. No integration required.

---

## References

- Full research document: `docs/research/aws-healthomics.md`
- Issue #75: https://github.com/spore-host/spore-host/issues/75
- AWS HealthOmics: https://aws.amazon.com/healthomics/
