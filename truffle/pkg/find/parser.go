// Package find implements the natural language EC2 instance search pipeline
// used by the truffle tool. It covers three stages:
//
//  1. Parsing: [ParseQuery] converts a free-text query ("nvidia h100 8gpu",
//     "amd epyc genoa 64gb memory") into a structured [ParsedQuery].
//
//  2. Criteria building: [ParsedQuery.BuildCriteria] translates the parsed
//     query into a [SearchCriteria] containing a compiled regexp and
//     [FilterOptions] ready to pass to truffle/pkg/aws.SearchInstanceTypes.
//
//  3. Result enrichment: [ExplainMatch] annotates each result with
//     human-readable match reasons (e.g., "GPU: A100 (80 GiB, training)").
//
// Typical usage:
//
//	pq, err := find.ParseQuery("nvidia h100 8gpu")
//	criteria, err := pq.BuildCriteria()
//	results, err := client.SearchInstanceTypes(ctx, regions, criteria.InstanceTypePattern, criteria.FilterOptions)
//	for _, r := range results {
//	    reasons := find.ExplainMatch(r, pq)
//	}
package find

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/scttfrdmn/spore-host/truffle/pkg/metadata"
)

// TokenType represents the type of a parsed token
type TokenType int

const (
	TokenUnknown TokenType = iota
	TokenVendor
	TokenProcessor
	TokenGPU
	TokenSize
	TokenVCPU
	TokenMemory
	TokenGPUCount
	TokenArchitecture
	TokenNetworkSpeed
	TokenEFA
)

// Token represents a single classified word from a natural language query.
type Token struct {
	Type  TokenType // Semantic classification of this token
	Value string    // Normalized canonical value, e.g. "nvidia", "128gb"
	Raw   string    // Original input text before normalization
}

// ParsedQuery is the structured output of [ParseQuery]. It holds all constraints
// extracted from the user's free-text input and is consumed by [ParsedQuery.BuildCriteria].
type ParsedQuery struct {
	Vendors        []string // Hardware vendor filters, e.g. ["amd"], ["nvidia"]
	Processors     []string // Processor code names, e.g. ["genoa", "sapphire rapids"]
	GPUs           []string // GPU model names, e.g. ["h100", "a100"]
	Sizes          []string // Size-category filters, e.g. ["large", "xlarge"]
	MinVCPU        int      // Minimum vCPU count; 0 means unconstrained
	MinMemory      float64  // Minimum memory in GiB; 0 means unconstrained
	GPUCount       int      // Minimum number of GPUs; 0 means unconstrained
	Architecture   string   // "x86_64" or "arm64"; empty means both
	MinNetworkGbps int      // Minimum network bandwidth in Gbps; 0 means unconstrained
	RequireEFA     bool     // If true, only match instance families with EFA support
	RawTokens      []Token  // Parsed tokens in input order, useful for diagnostics
}

var (
	numberRegex        = regexp.MustCompile(`^\d+$`)
	memoryRegex        = regexp.MustCompile(`^(\d+(?:\.\d+)?)\s*(gb|gib|g)$`)
	networkSpeedRegex  = regexp.MustCompile(`^(\d+)\s*(gbps|g)$`)
)

// ParseQuery parses a natural language query into structured search criteria
func ParseQuery(query string) (*ParsedQuery, error) {
	// Normalize: lowercase, trim
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return nil, fmt.Errorf("empty query")
	}

	// Tokenize: split on whitespace
	words := strings.Fields(query)

	// Classify tokens
	tokens := classifyTokens(words)

	// Build ParsedQuery
	pq := &ParsedQuery{RawTokens: tokens}
	for _, token := range tokens {
		switch token.Type {
		case TokenVendor:
			pq.Vendors = append(pq.Vendors, token.Value)
		case TokenProcessor:
			pq.Processors = append(pq.Processors, token.Value)
		case TokenGPU:
			pq.GPUs = append(pq.GPUs, token.Value)
		case TokenSize:
			pq.Sizes = append(pq.Sizes, token.Value)
		case TokenVCPU:
			if v, err := strconv.Atoi(token.Value); err == nil {
				pq.MinVCPU = v
			}
		case TokenMemory:
			if v, err := parseMemory(token.Value); err == nil {
				pq.MinMemory = v
			}
		case TokenGPUCount:
			if v, err := strconv.Atoi(token.Value); err == nil {
				pq.GPUCount = v
			}
		case TokenArchitecture:
			pq.Architecture = token.Value
		case TokenNetworkSpeed:
			if v, err := parseNetworkSpeed(token.Value); err == nil {
				pq.MinNetworkGbps = v
			}
		case TokenEFA:
			pq.RequireEFA = true
		}
	}

	// Validate
	if err := pq.Validate(); err != nil {
		return nil, err
	}

	return pq, nil
}

func classifyTokens(words []string) []Token {
	var tokens []Token

	for i := 0; i < len(words); i++ {
		word := words[i]

		// Check multi-word patterns first (e.g., "ice lake", "sapphire rapids")
		if i+1 < len(words) {
			twoWord := word + " " + words[i+1]
			if _, ok := metadata.ProcessorDatabase[twoWord]; ok {
				tokens = append(tokens, Token{
					Type:  TokenProcessor,
					Value: twoWord,
					Raw:   twoWord,
				})
				i++
				continue
			}
			if _, ok := metadata.GPUDatabase[twoWord]; ok {
				tokens = append(tokens, Token{
					Type:  TokenGPU,
					Value: twoWord,
					Raw:   twoWord,
				})
				i++
				continue
			}
		}

		// Check three-word patterns (e.g., "radeon pro v520")
		if i+2 < len(words) {
			threeWord := word + " " + words[i+1] + " " + words[i+2]
			if _, ok := metadata.GPUDatabase[threeWord]; ok {
				tokens = append(tokens, Token{
					Type:  TokenGPU,
					Value: threeWord,
					Raw:   threeWord,
				})
				i += 2
				continue
			}
		}

		// Single-word patterns
		// Check vendor aliases first before processor database
		if vendor, ok := metadata.VendorAliases[word]; ok {
			tokens = append(tokens, Token{Type: TokenVendor, Value: vendor, Raw: word})
		} else if _, ok := metadata.ProcessorDatabase[word]; ok {
			tokens = append(tokens, Token{Type: TokenProcessor, Value: word, Raw: word})
		} else if _, ok := metadata.GPUDatabase[word]; ok {
			tokens = append(tokens, Token{Type: TokenGPU, Value: word, Raw: word})
		} else if alias, ok := metadata.GPUAliases[word]; ok {
			tokens = append(tokens, Token{Type: TokenGPU, Value: alias, Raw: word})
		} else if _, ok := metadata.SizeCategories[word]; ok {
			tokens = append(tokens, Token{Type: TokenSize, Value: word, Raw: word})
		} else if word == "efa" {
			tokens = append(tokens, Token{Type: TokenEFA, Value: "efa", Raw: word})
		} else if alias, ok := metadata.NetworkAliases[word]; ok {
			if alias == "efa" {
				tokens = append(tokens, Token{Type: TokenEFA, Value: "efa", Raw: word})
			} else {
				// It's a bandwidth alias
				tokens = append(tokens, Token{Type: TokenNetworkSpeed, Value: alias, Raw: word})
			}
		} else if networkSpeedRegex.MatchString(word) {
			tokens = append(tokens, Token{Type: TokenNetworkSpeed, Value: word, Raw: word})
		} else if word == "x86_64" || word == "x86-64" || word == "x86" || word == "amd64" {
			tokens = append(tokens, Token{Type: TokenArchitecture, Value: "x86_64", Raw: word})
		} else if word == "arm64" || word == "arm" || word == "aarch64" {
			tokens = append(tokens, Token{Type: TokenArchitecture, Value: "arm64", Raw: word})
		} else if numberRegex.MatchString(word) {
			// Look ahead for units
			if i+1 < len(words) {
				next := words[i+1]
				if next == "cores" || next == "core" || next == "vcpus" || next == "vcpu" || next == "cpus" || next == "cpu" {
					tokens = append(tokens, Token{Type: TokenVCPU, Value: word, Raw: word + " " + next})
					i++
				} else if next == "gpus" || next == "gpu" {
					tokens = append(tokens, Token{Type: TokenGPUCount, Value: word, Raw: word + " " + next})
					i++
				} else if memoryRegex.MatchString(next) || strings.HasSuffix(next, "gb") || strings.HasSuffix(next, "gib") || strings.HasSuffix(next, "g") {
					tokens = append(tokens, Token{Type: TokenMemory, Value: word + next, Raw: word + next})
					i++
				}
			}
		} else if memoryRegex.MatchString(word) {
			tokens = append(tokens, Token{Type: TokenMemory, Value: word, Raw: word})
		} else {
			tokens = append(tokens, Token{Type: TokenUnknown, Value: word, Raw: word})
		}
	}

	return tokens
}

// parseMemory parses memory string (e.g., "32gb", "64gib") to GiB
func parseMemory(s string) (float64, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	matches := memoryRegex.FindStringSubmatch(s)
	if len(matches) != 3 {
		return 0, fmt.Errorf("invalid memory format: %s", s)
	}

	value, err := strconv.ParseFloat(matches[1], 64)
	if err != nil {
		return 0, err
	}

	// All units are treated as GiB
	return value, nil
}

// parseNetworkSpeed parses network speed string (e.g., "10gbps", "100g") to Gbps
func parseNetworkSpeed(s string) (int, error) {
	s = strings.ToLower(strings.TrimSpace(s))

	// Check if it's a known alias (e.g., "10gbps", "25gbps")
	if _, ok := metadata.NetworkBandwidthTiers[s]; ok {
		// Extract the number from the key (e.g., "10gbps" -> 10)
		matches := regexp.MustCompile(`^(\d+)`).FindStringSubmatch(s)
		if len(matches) == 2 {
			if v, err := strconv.Atoi(matches[1]); err == nil {
				return v, nil
			}
		}
	}

	// Try parsing as "100gbps" or "100g"
	matches := networkSpeedRegex.FindStringSubmatch(s)
	if len(matches) == 3 {
		value, err := strconv.Atoi(matches[1])
		if err != nil {
			return 0, err
		}
		return value, nil
	}

	return 0, fmt.Errorf("invalid network speed format: %s", s)
}

// Validate checks for conflicting or invalid query criteria
func (pq *ParsedQuery) Validate() error {
	// Check for conflicting architectures
	archSet := make(map[string]bool)

	// From processors
	for _, proc := range pq.Processors {
		if info, ok := metadata.ProcessorDatabase[proc]; ok {
			archSet[info.Architecture] = true
		}
	}

	// From vendors
	for _, vendor := range pq.Vendors {
		for _, info := range metadata.ProcessorDatabase {
			if info.Vendor == vendor {
				archSet[info.Architecture] = true
			}
		}
	}

	// From explicit architecture
	if pq.Architecture != "" {
		archSet[pq.Architecture] = true
	}

	if len(archSet) > 1 {
		archs := make([]string, 0, len(archSet))
		for arch := range archSet {
			archs = append(archs, arch)
		}
		return fmt.Errorf("conflicting architectures: %v", archs)
	}

	return nil
}

// ResolveInstanceFamilies returns all instance families matching the query
func (pq *ParsedQuery) ResolveInstanceFamilies() []string {
	familySet := make(map[string]bool)

	// From processors
	for _, proc := range pq.Processors {
		if info, ok := metadata.ProcessorDatabase[proc]; ok {
			for _, family := range info.Families {
				familySet[family] = true
			}
		}
	}

	// From vendors
	for _, vendor := range pq.Vendors {
		families := metadata.GetFamiliesByVendor(vendor)
		for _, family := range families {
			familySet[family] = true
		}
	}

	// From GPUs (use families for fuzzy matching)
	for _, gpu := range pq.GPUs {
		if info, ok := metadata.GPUDatabase[gpu]; ok {
			for _, family := range info.Families {
				familySet[family] = true
			}
		}
	}

	// From network requirements
	if pq.RequireEFA {
		efaFamilies := metadata.GetFamiliesByEFA()
		for _, family := range efaFamilies {
			familySet[family] = true
		}
	}

	if pq.MinNetworkGbps > 0 {
		networkFamilies := metadata.GetFamiliesByNetworkSpeed(pq.MinNetworkGbps)
		for _, family := range networkFamilies {
			familySet[family] = true
		}
	}

	families := make([]string, 0, len(familySet))
	for family := range familySet {
		families = append(families, family)
	}

	return families
}

// ResolveGPUInstances returns exact instance types for GPU queries
func (pq *ParsedQuery) ResolveGPUInstances() []string {
	instanceSet := make(map[string]bool)

	for _, gpu := range pq.GPUs {
		if info, ok := metadata.GPUDatabase[gpu]; ok {
			for _, inst := range info.InstanceTypes {
				instanceSet[inst] = true
			}
		}
	}

	instances := make([]string, 0, len(instanceSet))
	for inst := range instanceSet {
		instances = append(instances, inst)
	}

	return instances
}

// DeriveArchitecture determines the architecture from query criteria
func (pq *ParsedQuery) DeriveArchitecture() string {
	if pq.Architecture != "" {
		return pq.Architecture
	}

	archSet := make(map[string]bool)

	// From processors
	for _, proc := range pq.Processors {
		if info, ok := metadata.ProcessorDatabase[proc]; ok {
			archSet[info.Architecture] = true
		}
	}

	// From vendors
	for _, vendor := range pq.Vendors {
		for _, info := range metadata.ProcessorDatabase {
			if info.Vendor == vendor {
				archSet[info.Architecture] = true
			}
		}
	}

	// Return architecture only if unambiguous
	if len(archSet) == 1 {
		for arch := range archSet {
			return arch
		}
	}

	return ""
}

// BuildSizePattern returns a regex pattern for size filtering
func (pq *ParsedQuery) BuildSizePattern() string {
	sizeSet := make(map[string]bool)

	for _, sizeCategory := range pq.Sizes {
		sizes := metadata.GetSizesForCategory(sizeCategory)
		for _, size := range sizes {
			sizeSet[size] = true
		}
	}

	if len(sizeSet) == 0 {
		return ".*"
	}

	sizes := make([]string, 0, len(sizeSet))
	for size := range sizeSet {
		sizes = append(sizes, regexp.QuoteMeta(size))
	}

	return "(" + strings.Join(sizes, "|") + ")"
}
