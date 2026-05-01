package find

import (
	"fmt"
	"strings"

	"github.com/scttfrdmn/spore-host/truffle/pkg/aws"
	"github.com/scttfrdmn/spore-host/truffle/pkg/metadata"
)

// FindResult extends [aws.InstanceTypeResult] with match explanations produced
// by [ExplainMatch], useful for displaying to end users why a result was returned.
type FindResult struct {
	aws.InstanceTypeResult              // Embedded full result from the AWS query
	MatchReasons   []string             // Human-readable explanations of why this instance matched the query
	MatchScore     int                  // Relevance score for sorting; higher means more specific match
}

// ExplainMatch generates human-readable reasons why an instance matched the query
func ExplainMatch(result aws.InstanceTypeResult, query *ParsedQuery) []string {
	var reasons []string

	family := extractFamily(result.InstanceType)

	// Check processor match
	for _, proc := range query.Processors {
		if info, ok := metadata.ProcessorDatabase[proc]; ok {
			for _, f := range info.Families {
				if f == family {
					reasons = append(reasons,
						fmt.Sprintf("Processor: %s (%s %s)",
							info.CodeName, info.Vendor, info.Generation))
					goto processorDone
				}
			}
		}
	}
processorDone:

	// Check vendor match
	for _, vendor := range query.Vendors {
		for _, info := range metadata.ProcessorDatabase {
			if info.Vendor == vendor {
				for _, f := range info.Families {
					if f == family {
						reasons = append(reasons, fmt.Sprintf("Vendor: %s", vendor))
						goto vendorDone
					}
				}
			}
		}
	}
vendorDone:

	// Check GPU match
	for _, gpu := range query.GPUs {
		if info, ok := metadata.GPUDatabase[gpu]; ok {
			// Check exact instance type match
			for _, inst := range info.InstanceTypes {
				if inst == result.InstanceType {
					reasons = append(reasons,
						fmt.Sprintf("GPU: %s (%d GB, %s)",
							info.Name, info.MemoryGB, info.UseCase))
					goto gpuDone
				}
			}
			// Check family match
			for _, f := range info.Families {
				if f == family {
					reasons = append(reasons,
						fmt.Sprintf("GPU family: %s (%s)",
							info.Name, info.UseCase))
					goto gpuDone
				}
			}
		}
	}
gpuDone:

	// Check size match
	for _, size := range query.Sizes {
		sizes := metadata.GetSizesForCategory(size)
		for _, s := range sizes {
			if strings.HasSuffix(result.InstanceType, "."+s) {
				reasons = append(reasons, fmt.Sprintf("Size: %s", size))
				goto sizeDone
			}
		}
	}
sizeDone:

	// Check vCPU match
	if query.MinVCPU > 0 && result.VCPUs >= int32(query.MinVCPU) {
		reasons = append(reasons,
			fmt.Sprintf("vCPUs: %d >= %d", result.VCPUs, query.MinVCPU))
	}

	// Check memory match
	if query.MinMemory > 0 {
		memGiB := float64(result.MemoryMiB) / 1024.0
		if memGiB >= query.MinMemory {
			reasons = append(reasons,
				fmt.Sprintf("Memory: %.0f GiB >= %.0f GiB", memGiB, query.MinMemory))
		}
	}

	// Check architecture match
	if query.Architecture != "" && strings.EqualFold(result.Architecture, query.Architecture) {
		reasons = append(reasons, fmt.Sprintf("Architecture: %s", result.Architecture))
	}

	// Check EFA match
	if query.RequireEFA && metadata.IsEFASupported(family) {
		reasons = append(reasons, "Network: EFA supported")
	}

	// Check network speed match
	if query.MinNetworkGbps > 0 {
		// Check if family supports the required bandwidth
		for speed, capability := range metadata.NetworkBandwidthTiers {
			if capability.MaxBandwidthGbps >= query.MinNetworkGbps {
				for _, f := range capability.Families {
					if f == family {
						reasons = append(reasons,
							fmt.Sprintf("Network: %d+ Gbps (supports %s)", query.MinNetworkGbps, speed))
						goto networkDone
					}
				}
			}
		}
	}
networkDone:

	return reasons
}

// extractFamily extracts the instance family from an instance type
// e.g., "m6i.2xlarge" -> "m6i"
func extractFamily(instanceType string) string {
	parts := strings.Split(instanceType, ".")
	if len(parts) > 0 {
		return parts[0]
	}
	return ""
}
