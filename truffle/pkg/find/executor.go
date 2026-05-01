package find

import (
	"regexp"
	"strings"

	"github.com/scttfrdmn/spore-host/truffle/pkg/aws"
)

// SearchCriteria holds the compiled, ready-to-execute form of a [ParsedQuery].
// Pass InstanceTypePattern and FilterOptions directly to aws.SearchInstanceTypes.
type SearchCriteria struct {
	InstanceTypePattern *regexp.Regexp   // Compiled regexp matching eligible EC2 instance type strings
	FilterOptions       aws.FilterOptions // Numeric and categorical filters passed to SearchInstanceTypes
}

// BuildCriteria converts a ParsedQuery into SearchCriteria for execution
func (pq *ParsedQuery) BuildCriteria() (*SearchCriteria, error) {
	sc := &SearchCriteria{
		FilterOptions: aws.FilterOptions{
			IncludeAZs:   true,
			MinVCPUs:     pq.MinVCPU,
			MinMemory:    pq.MinMemory,
			Architecture: pq.DeriveArchitecture(),
		},
	}

	// Build instance type pattern
	pattern := pq.buildInstanceTypePattern()
	sc.InstanceTypePattern = regexp.MustCompile(pattern)

	return sc, nil
}

func (pq *ParsedQuery) buildInstanceTypePattern() string {
	// If we have GPU queries with exact instance types, use those
	if len(pq.GPUs) > 0 {
		instances := pq.ResolveGPUInstances()
		if len(instances) > 0 {
			// Exact match on instance types
			escaped := make([]string, len(instances))
			for i, inst := range instances {
				escaped[i] = regexp.QuoteMeta(inst)
			}
			return "^(" + strings.Join(escaped, "|") + ")$"
		}
	}

	// Otherwise, resolve instance families
	families := pq.ResolveInstanceFamilies()

	if len(families) == 0 {
		// No specific criteria; match all
		return ".*"
	}

	// Build pattern with family and optional size constraints
	escapedFamilies := make([]string, len(families))
	for i, family := range families {
		escapedFamilies[i] = regexp.QuoteMeta(family)
	}

	familyPattern := "(" + strings.Join(escapedFamilies, "|") + ")"

	// Add size constraints if present
	if len(pq.Sizes) > 0 {
		sizePattern := pq.BuildSizePattern()
		return "^" + familyPattern + "\\." + sizePattern + "$"
	}

	// Match any size for the families
	return "^" + familyPattern + "\\..*$"
}

// Matcher returns a function suitable for aws.SearchInstanceTypes
func (sc *SearchCriteria) Matcher() func(string) bool {
	return func(instanceType string) bool {
		return sc.InstanceTypePattern.MatchString(instanceType)
	}
}
