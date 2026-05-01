// Package aws provides EC2 capacity discovery for the truffle tool.
// It searches instance type availability, retrieves Spot pricing history,
// and queries On-Demand Capacity Reservations (ODCRs) and Capacity Blocks
// for ML workloads across one or more AWS regions concurrently.
//
// Typical usage:
//
//	client, err := aws.NewClient(ctx)
//	results, err := client.SearchInstanceTypes(ctx, []string{"us-east-1"}, pattern, filterOpts)
//	prices, err := client.GetSpotPricing(ctx, results, aws.SpotOptions{ShowSavings: true})
package aws

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// Client wraps AWS SDK clients
type Client struct {
	cfg aws.Config
}

// InstanceTypeResult represents an instance type's availability and specifications
// in a given region, as returned by [Client.SearchInstanceTypes].
type InstanceTypeResult struct {
	InstanceType   string   `json:"instance_type" yaml:"instance_type"`           // EC2 instance type, e.g. "m6i.2xlarge"
	Region         string   `json:"region" yaml:"region"`                         // AWS region where this type is available
	AvailableAZs   []string `json:"availability_zones,omitempty" yaml:"availability_zones,omitempty"` // AZs with capacity; populated when FilterOptions.IncludeAZs is true
	VCPUs          int32    `json:"vcpus,omitempty" yaml:"vcpus,omitempty"`       // Default vCPU count
	MemoryMiB      int64    `json:"memory_mib,omitempty" yaml:"memory_mib,omitempty"` // Memory in MiB
	Architecture   string   `json:"architecture,omitempty" yaml:"architecture,omitempty"` // CPU architecture: "x86_64" or "arm64"
	InstanceFamily string   `json:"instance_family,omitempty" yaml:"instance_family,omitempty"` // Family prefix, e.g. "m6i"
	GPUs            int32   `json:"gpus,omitempty" yaml:"gpus,omitempty"`         // Number of GPUs; 0 for non-GPU instances
	GPUMemoryMiB    int64   `json:"gpu_memory_mib,omitempty" yaml:"gpu_memory_mib,omitempty"` // Total GPU memory in MiB across all GPUs
	GPUModel        string  `json:"gpu_model,omitempty" yaml:"gpu_model,omitempty"`           // GPU model name, e.g. "A100"
	GPUManufacturer string  `json:"gpu_manufacturer,omitempty" yaml:"gpu_manufacturer,omitempty"` // GPU vendor, e.g. "nvidia"
	OnDemandPrice   float64 `json:"on_demand_price,omitempty" yaml:"on_demand_price,omitempty"` // On-demand $/hr; 0 if not yet fetched
}

// SpotPriceResult represents a Spot instance price observation for one AZ,
// as returned by [Client.GetSpotPricing].
type SpotPriceResult struct {
	InstanceType     string  `json:"instance_type" yaml:"instance_type"`   // EC2 instance type
	Region           string  `json:"region" yaml:"region"`                 // AWS region
	AvailabilityZone string  `json:"availability_zone" yaml:"availability_zone"` // AZ where this price applies
	SpotPrice        float64 `json:"spot_price" yaml:"spot_price"`         // Current Spot price in $/hr
	OnDemandPrice    float64 `json:"on_demand_price,omitempty" yaml:"on_demand_price,omitempty"` // On-demand $/hr for savings calculation; 0 if unavailable
	SavingsPercent   float64 `json:"savings_percent,omitempty" yaml:"savings_percent,omitempty"` // Discount vs on-demand: 100*(1-spot/ondemand); set when SpotOptions.ShowSavings is true
	Timestamp        string  `json:"timestamp" yaml:"timestamp"`           // RFC3339 timestamp of the price observation
	ProductType      string  `json:"product_type,omitempty" yaml:"product_type,omitempty"` // OS description, e.g. "Linux/UNIX"
}

// FilterOptions controls which instance types are returned by [Client.SearchInstanceTypes].
type FilterOptions struct {
	IncludeAZs     bool    // If true, populate InstanceTypeResult.AvailableAZs (one extra API call per type)
	Architecture   string  // Filter to "x86_64" or "arm64"; empty matches both
	MinVCPUs       int     // Minimum vCPU count; 0 disables this filter
	MinMemory      float64 // Minimum memory in GiB; 0 disables this filter
	InstanceFamily string  // Restrict to a family prefix, e.g. "m6i"; empty matches all
	Verbose        bool    // If true, log per-region progress to stderr
}

// SpotOptions controls the behavior of [Client.GetSpotPricing].
type SpotOptions struct {
	MaxPrice      float64 // Exclude results above this $/hr threshold; 0 disables
	ShowSavings   bool    // Populate SpotPriceResult.SavingsPercent by comparing with on-demand price
	LookbackHours int     // Hours of price history to query; 0 uses the AWS default (typically 1 hour)
	OnlyActive    bool    // Exclude price history entries with no current offering
	Verbose       bool    // If true, log per-region progress to stderr
}

// CapacityReservationResult represents an ODCR (On-Demand Capacity Reservation)
type CapacityReservationResult struct {
	ReservationID      string   `json:"reservation_id" yaml:"reservation_id"`
	InstanceType       string   `json:"instance_type" yaml:"instance_type"`
	Region             string   `json:"region" yaml:"region"`
	AvailabilityZone   string   `json:"availability_zone" yaml:"availability_zone"`
	TotalCapacity      int32    `json:"total_capacity" yaml:"total_capacity"`
	AvailableCapacity  int32    `json:"available_capacity" yaml:"available_capacity"`
	UsedCapacity       int32    `json:"used_capacity" yaml:"used_capacity"`
	State              string   `json:"state" yaml:"state"`
	Tenancy            string   `json:"tenancy" yaml:"tenancy"`
	EBSOptimized       bool     `json:"ebs_optimized" yaml:"ebs_optimized"`
	EndDate            string   `json:"end_date,omitempty" yaml:"end_date,omitempty"`
	Platform           string   `json:"platform" yaml:"platform"`
	Tags               []string `json:"tags,omitempty" yaml:"tags,omitempty"`
}

// CapacityReservationOptions contains ODCR search options
type CapacityReservationOptions struct {
	InstanceTypes  []string
	OnlyAvailable  bool   // Only show reservations with available capacity
	OnlyActive     bool   // Only show active reservations
	IncludeExpired bool   // Include expired reservations
	MinCapacity    int32  // Minimum available capacity
	Verbose        bool
}

// CapacityBlockResult represents a Capacity Block for ML
type CapacityBlockResult struct {
	CapacityBlockID       string   `json:"capacity_block_id" yaml:"capacity_block_id"`
	InstanceType          string   `json:"instance_type" yaml:"instance_type"`
	InstanceCount         int32    `json:"instance_count" yaml:"instance_count"`
	AvailabilityZone      string   `json:"availability_zone" yaml:"availability_zone"`
	StartDate             string   `json:"start_date" yaml:"start_date"`
	EndDate               string   `json:"end_date" yaml:"end_date"`
	DurationHours         int32    `json:"duration_hours" yaml:"duration_hours"`
	State                 string   `json:"state" yaml:"state"` // scheduled, active, completed, cancelled
	ReservationFee        float64  `json:"reservation_fee" yaml:"reservation_fee"`
	UltraClusterPlacement bool     `json:"ultra_cluster_placement" yaml:"ultra_cluster_placement"`
	Tags                  []string `json:"tags,omitempty" yaml:"tags,omitempty"`
}

// CapacityBlockOptions contains Capacity Block search options
type CapacityBlockOptions struct {
	InstanceTypes []string
	MinDuration   int32 // Minimum duration in hours
	MaxDuration   int32 // Maximum duration in hours
	StartAfter    string // ISO format datetime
	StartBefore   string // ISO format datetime
	OnlyActive    bool
	Verbose       bool
}

// NewClient creates a new AWS client using the default credential chain.
func NewClient(ctx context.Context) (*Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("unable to load AWS SDK config: %w", err)
	}
	return NewClientFromConfig(cfg), nil
}

// NewClientFromConfig creates a new AWS client with an injected aws.Config.
// Use this in tests to point the client at a Substrate emulator.
func NewClientFromConfig(cfg aws.Config) *Client {
	return &Client{cfg: cfg}
}

// GetEnabledRegions returns AWS regions enabled for this account.
// This respects Service Control Policies (SCPs) that may restrict regions.
// Regions blocked by organizational SCPs will not appear in the returned list.
func (c *Client) GetEnabledRegions(ctx context.Context) ([]string, error) {
	client := ec2.NewFromConfig(c.cfg)

	// DescribeRegions with AllRegions=false returns only enabled regions
	// This automatically respects SCPs and account-level region restrictions
	result, err := client.DescribeRegions(ctx, &ec2.DescribeRegionsInput{
		AllRegions: boolPtr(false), // Only enabled regions
	})
	if err != nil {
		return nil, fmt.Errorf("failed to describe regions: %w", err)
	}

	regions := make([]string, 0, len(result.Regions))
	for _, region := range result.Regions {
		if region.RegionName != nil {
			regions = append(regions, *region.RegionName)
		}
	}

	return regions, nil
}

// GetAllRegions is deprecated. Use GetEnabledRegions instead.
// This method is kept for backward compatibility.
func (c *Client) GetAllRegions(ctx context.Context) ([]string, error) {
	return c.GetEnabledRegions(ctx)
}

// GetInstanceTypes returns all instance types in a region
func (c *Client) GetInstanceTypes(ctx context.Context, region string) ([]string, error) {
	cfg := c.cfg
	cfg.Region = region
	client := ec2.NewFromConfig(cfg)

	var instanceTypes []string
	paginator := ec2.NewDescribeInstanceTypesPaginator(client, &ec2.DescribeInstanceTypesInput{})

	for paginator.HasMorePages() {
		output, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to describe instance types in %s: %w", region, err)
		}

		for _, it := range output.InstanceTypes {
			instanceTypes = append(instanceTypes, string(it.InstanceType))
		}
	}

	return instanceTypes, nil
}

// SearchInstanceTypes searches for instance types matching the pattern across regions
func (c *Client) SearchInstanceTypes(ctx context.Context, regions []string, matcher *regexp.Regexp, opts FilterOptions) ([]InstanceTypeResult, error) {
	var (
		results []InstanceTypeResult
		mu      sync.Mutex
		wg      sync.WaitGroup
		errCh   = make(chan error, len(regions))
	)

	// Limit concurrent region queries
	semaphore := make(chan struct{}, 10)

	for _, region := range regions {
		wg.Add(1)
		go func(r string) {
			defer wg.Done()
			semaphore <- struct{}{}        // Acquire
			defer func() { <-semaphore }() // Release

			if opts.Verbose {
				fmt.Fprintf(os.Stderr, "  Checking region: %s\n", r)
			}

			regionResults, err := c.searchInRegion(ctx, r, matcher, opts)
			if err != nil {
				errCh <- fmt.Errorf("region %s: %w", r, err)
				return
			}

			if len(regionResults) > 0 {
				mu.Lock()
				results = append(results, regionResults...)
				mu.Unlock()
			}
		}(region)
	}

	wg.Wait()
	close(errCh)

	// Collect any errors
	for err := range errCh {
		if opts.Verbose {
			fmt.Fprintf(os.Stderr, "⚠️  Warning: %v\n", err)
		}
	}

	return results, nil
}

func (c *Client) searchInRegion(ctx context.Context, region string, matcher *regexp.Regexp, opts FilterOptions) ([]InstanceTypeResult, error) {
	cfg := c.cfg
	cfg.Region = region
	client := ec2.NewFromConfig(cfg)

	var results []InstanceTypeResult

	// Optimize: if pattern matches specific instance type(s), use API filter
	input := &ec2.DescribeInstanceTypesInput{}
	if specificTypes := extractSpecificTypes(matcher); len(specificTypes) > 0 {
		input.InstanceTypes = specificTypes
	}

	paginator := ec2.NewDescribeInstanceTypesPaginator(client, input)

	for paginator.HasMorePages() {
		output, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}

		for _, it := range output.InstanceTypes {
			instanceType := string(it.InstanceType)

			// Check if matches pattern
			if !matcher.MatchString(instanceType) {
				continue
			}

			// Apply filters
			if !matchesFilters(it, opts) {
				continue
			}

			result := InstanceTypeResult{
				InstanceType:   instanceType,
				Region:         region,
				VCPUs:          valueOrZero(it.VCpuInfo.DefaultVCpus),
				MemoryMiB:      valueOrZero(it.MemoryInfo.SizeInMiB),
				InstanceFamily: extractFamily(instanceType),
			}

			// Get architecture
			if len(it.ProcessorInfo.SupportedArchitectures) > 0 {
				result.Architecture = string(it.ProcessorInfo.SupportedArchitectures[0])
			}

			// Get GPU info
			if it.GpuInfo != nil && len(it.GpuInfo.Gpus) > 0 {
				for _, gpu := range it.GpuInfo.Gpus {
					result.GPUs += valueOrZero(gpu.Count)
					if gpu.Name != nil {
						result.GPUModel = *gpu.Name
					}
					if gpu.Manufacturer != nil {
						result.GPUManufacturer = *gpu.Manufacturer
					}
					if gpu.MemoryInfo != nil && gpu.MemoryInfo.SizeInMiB != nil {
						result.GPUMemoryMiB = int64(*gpu.MemoryInfo.SizeInMiB) * int64(valueOrZero(gpu.Count))
					}
				}
				// Use total if per-GPU not available
				if result.GPUMemoryMiB == 0 && it.GpuInfo.TotalGpuMemoryInMiB != nil {
					result.GPUMemoryMiB = int64(valueOrZero(it.GpuInfo.TotalGpuMemoryInMiB))
				}
			}

			// Get availability zones if requested
			if opts.IncludeAZs {
				azs, err := c.getAvailabilityZones(ctx, region, instanceType)
				if err == nil {
					result.AvailableAZs = azs
				}
			}

			results = append(results, result)
		}
	}

	return results, nil
}

func (c *Client) getAvailabilityZones(ctx context.Context, region, instanceType string) ([]string, error) {
	cfg := c.cfg
	cfg.Region = region
	client := ec2.NewFromConfig(cfg)

	output, err := client.DescribeInstanceTypeOfferings(ctx, &ec2.DescribeInstanceTypeOfferingsInput{
		LocationType: types.LocationTypeAvailabilityZone,
		Filters: []types.Filter{
			{
				Name:   stringPtr("instance-type"),
				Values: []string{instanceType},
			},
		},
	})
	if err != nil {
		return nil, err
	}

	azs := make([]string, 0, len(output.InstanceTypeOfferings))
	for _, offering := range output.InstanceTypeOfferings {
		if offering.Location != nil {
			azs = append(azs, *offering.Location)
		}
	}

	return azs, nil
}

func matchesFilters(it types.InstanceTypeInfo, opts FilterOptions) bool {
	// Architecture filter
	if opts.Architecture != "" {
		archMatch := false
		for _, arch := range it.ProcessorInfo.SupportedArchitectures {
			if string(arch) == opts.Architecture {
				archMatch = true
				break
			}
		}
		if !archMatch {
			return false
		}
	}

	// vCPU filter
	if opts.MinVCPUs > 0 {
		vcpus := valueOrZero(it.VCpuInfo.DefaultVCpus)
		if int(vcpus) < opts.MinVCPUs {
			return false
		}
	}

	// Memory filter (convert GiB to MiB)
	if opts.MinMemory > 0 {
		memMiB := valueOrZero(it.MemoryInfo.SizeInMiB)
		memGiB := float64(memMiB) / 1024.0
		if memGiB < opts.MinMemory {
			return false
		}
	}

	// Instance family filter
	if opts.InstanceFamily != "" {
		family := extractFamily(string(it.InstanceType))
		if family != opts.InstanceFamily {
			return false
		}
	}

	return true
}

func extractFamily(instanceType string) string {
	// Extract family from instance type (e.g., "m5" from "m5.large")
	for i, c := range instanceType {
		if c == '.' {
			return instanceType[:i]
		}
	}
	return instanceType
}

// extractSpecificTypes analyzes regex and returns specific instance types if pattern is exact
func extractSpecificTypes(matcher *regexp.Regexp) []types.InstanceType {
	pattern := matcher.String()

	// Check if pattern is a specific instance type (no regex metacharacters except ^$)
	// Simple heuristic: if it contains *, +, ?, [, ], (, ), |, then it's a wildcard
	if containsWildcard(pattern) {
		return nil // Wildcard pattern, need to fetch all
	}

	// Remove ^ and $ anchors if present
	pattern = strings.TrimPrefix(pattern, "^")
	pattern = strings.TrimSuffix(pattern, "$")

	// Unescape regex escapes like \. -> .
	pattern = strings.ReplaceAll(pattern, "\\.", ".")

	// Pattern is specific, return as filter
	return []types.InstanceType{types.InstanceType(pattern)}
}

func containsWildcard(pattern string) bool {
	wildcards := []string{".*", ".+", ".?", "[", "]", "(", ")", "|", "\\d", "\\w", "\\s"}
	for _, wc := range wildcards {
		if strings.Contains(pattern, wc) {
			return true
		}
	}
	return false
}

func valueOrZero[T any](ptr *T) T {
	if ptr != nil {
		return *ptr
	}
	var zero T
	return zero
}

func stringPtr(s string) *string {
	return &s
}

func boolPtr(b bool) *bool {
	return &b
}

// GetSpotPricing retrieves current Spot pricing for instance types
func (c *Client) GetSpotPricing(ctx context.Context, instances []InstanceTypeResult, opts SpotOptions) ([]SpotPriceResult, error) {
	var (
		results []SpotPriceResult
		mu      sync.Mutex
		wg      sync.WaitGroup
	)

	// Group instances by region
	regionInstances := make(map[string][]InstanceTypeResult)
	for _, inst := range instances {
		regionInstances[inst.Region] = append(regionInstances[inst.Region], inst)
	}

	// Limit concurrent region queries
	semaphore := make(chan struct{}, 10)

	for region, regInstances := range regionInstances {
		wg.Add(1)
		go func(r string, insts []InstanceTypeResult) {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()

			if opts.Verbose {
				fmt.Fprintf(os.Stderr, "  Fetching Spot prices in: %s\n", r)
			}

			regionResults, err := c.getRegionSpotPricing(ctx, r, insts, opts)
			if err != nil {
				if opts.Verbose {
					fmt.Fprintf(os.Stderr, "  Warning: failed to get Spot pricing for %s: %v\n", r, err)
				}
				return
			}

			if len(regionResults) > 0 {
				mu.Lock()
				results = append(results, regionResults...)
				mu.Unlock()
			}
		}(region, regInstances)
	}

	wg.Wait()
	return results, nil
}

func (c *Client) getRegionSpotPricing(ctx context.Context, region string, instances []InstanceTypeResult, opts SpotOptions) ([]SpotPriceResult, error) {
	cfg := c.cfg
	cfg.Region = region
	client := ec2.NewFromConfig(cfg)

	var results []SpotPriceResult
	
	// Calculate start time for price history
	startTime := time.Now().Add(-time.Duration(opts.LookbackHours) * time.Hour)

	// Deduplicate instances by type (callers may pass the same type multiple times)
	seen := make(map[string]bool)
	var deduped []InstanceTypeResult
	for _, inst := range instances {
		if !seen[inst.InstanceType] {
			seen[inst.InstanceType] = true
			deduped = append(deduped, inst)
		}
	}

	// Query each instance type
	for _, inst := range deduped {
		// Get Spot price history
		input := &ec2.DescribeSpotPriceHistoryInput{
			InstanceTypes: []types.InstanceType{types.InstanceType(inst.InstanceType)},
			StartTime:     &startTime,
			ProductDescriptions: []string{
				"Linux/UNIX",
			},
		}

		output, err := client.DescribeSpotPriceHistory(ctx, input)
		if err != nil {
			continue // Skip on error
		}

		// Process results - group by AZ and get latest price
		azPrices := make(map[string]*types.SpotPrice)
		for i := range output.SpotPriceHistory {
			sp := &output.SpotPriceHistory[i]
			if sp.AvailabilityZone == nil || sp.SpotPrice == nil {
				continue
			}

			az := *sp.AvailabilityZone
			
			// Keep only the most recent price per AZ
			if existing, ok := azPrices[az]; !ok || (sp.Timestamp != nil && existing.Timestamp != nil && sp.Timestamp.After(*existing.Timestamp)) {
				azPrices[az] = sp
			}
		}

		// Convert to results
		for az, spotPrice := range azPrices {
			if spotPrice.SpotPrice == nil {
				continue
			}

			price := parsePrice(*spotPrice.SpotPrice)
			
			// Apply max price filter
			if opts.MaxPrice > 0 && price > opts.MaxPrice {
				continue
			}

			result := SpotPriceResult{
				InstanceType:     inst.InstanceType,
				Region:           region,
				AvailabilityZone: az,
				SpotPrice:        price,
				ProductType:      string(spotPrice.ProductDescription),
			}

			if spotPrice.Timestamp != nil {
				result.Timestamp = spotPrice.Timestamp.Format(time.RFC3339)
			}

			results = append(results, result)
		}
	}

	return results, nil
}

func parsePrice(priceStr string) float64 {
	// AWS returns price as string, convert to float
	var price float64
	_, _ = fmt.Sscanf(priceStr, "%f", &price)
	return price
}

// GetCapacityReservations retrieves On-Demand Capacity Reservations (ODCRs)
func (c *Client) GetCapacityReservations(ctx context.Context, regions []string, opts CapacityReservationOptions) ([]CapacityReservationResult, error) {
	var (
		results []CapacityReservationResult
		mu      sync.Mutex
		wg      sync.WaitGroup
	)

	// Limit concurrent region queries
	semaphore := make(chan struct{}, 10)

	for _, region := range regions {
		wg.Add(1)
		go func(r string) {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()

			if opts.Verbose {
				fmt.Fprintf(os.Stderr, "  Checking capacity reservations in: %s\n", r)
			}

			regionResults, err := c.getRegionCapacityReservations(ctx, r, opts)
			if err != nil {
				if opts.Verbose {
					fmt.Fprintf(os.Stderr, "  Warning: failed to get capacity reservations for %s: %v\n", r, err)
				}
				return
			}

			if len(regionResults) > 0 {
				mu.Lock()
				results = append(results, regionResults...)
				mu.Unlock()
			}
		}(region)
	}

	wg.Wait()
	return results, nil
}

func (c *Client) getRegionCapacityReservations(ctx context.Context, region string, opts CapacityReservationOptions) ([]CapacityReservationResult, error) {
	cfg := c.cfg
	cfg.Region = region
	client := ec2.NewFromConfig(cfg)

	// Build filters
	filters := []types.Filter{}
	
	if len(opts.InstanceTypes) > 0 {
		filters = append(filters, types.Filter{
			Name:   stringPtr("instance-type"),
			Values: opts.InstanceTypes,
		})
	}

	if opts.OnlyActive {
		filters = append(filters, types.Filter{
			Name:   stringPtr("state"),
			Values: []string{"active"},
		})
	}

	input := &ec2.DescribeCapacityReservationsInput{
		Filters: filters,
	}

	var results []CapacityReservationResult

	// Paginate through results
	paginator := ec2.NewDescribeCapacityReservationsPaginator(client, input)
	for paginator.HasMorePages() {
		output, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}

		for _, cr := range output.CapacityReservations {
			// Apply filters
			if opts.OnlyAvailable && valueOrZero(cr.AvailableInstanceCount) == 0 {
				continue
			}

			if opts.MinCapacity > 0 && valueOrZero(cr.AvailableInstanceCount) < opts.MinCapacity {
				continue
			}

			state := string(cr.State)
			if !opts.IncludeExpired && (state == "expired" || state == "cancelled") {
				continue
			}

			result := CapacityReservationResult{
				ReservationID:     valueOrZero(cr.CapacityReservationId),
				InstanceType:      valueOrZero(cr.InstanceType),
				Region:            region,
				AvailabilityZone:  valueOrZero(cr.AvailabilityZone),
				TotalCapacity:     valueOrZero(cr.TotalInstanceCount),
				AvailableCapacity: valueOrZero(cr.AvailableInstanceCount),
				State:             state,
				Tenancy:           string(cr.Tenancy),
				EBSOptimized:      valueOrZero(cr.EbsOptimized),
				Platform:          string(cr.InstancePlatform),
			}

			result.UsedCapacity = result.TotalCapacity - result.AvailableCapacity

			if cr.EndDate != nil {
				result.EndDate = cr.EndDate.Format(time.RFC3339)
			}

			// Extract tags
			for _, tag := range cr.Tags {
				if tag.Key != nil && tag.Value != nil {
					result.Tags = append(result.Tags, fmt.Sprintf("%s=%s", *tag.Key, *tag.Value))
				}
			}

			results = append(results, result)
		}
	}

	return results, nil
}



// GetCapacityBlocks retrieves Capacity Blocks for ML
func (c *Client) GetCapacityBlocks(ctx context.Context, regions []string, opts CapacityBlockOptions) ([]CapacityBlockResult, error) {
	var (
		results []CapacityBlockResult
		mu      sync.Mutex
		wg      sync.WaitGroup
	)

	// Limit concurrent region queries
	semaphore := make(chan struct{}, 10)

	for _, region := range regions {
		wg.Add(1)
		go func(r string) {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()

			if opts.Verbose {
				fmt.Fprintf(os.Stderr, "  Checking Capacity Blocks for ML in: %s\n", r)
			}

			regionResults, err := c.getRegionCapacityBlocks(ctx, r, opts)
			if err != nil {
				if opts.Verbose {
					fmt.Fprintf(os.Stderr, "  Warning: failed to get Capacity Blocks for %s: %v\n", r, err)
				}
				return
			}

			if len(regionResults) > 0 {
				mu.Lock()
				results = append(results, regionResults...)
				mu.Unlock()
			}
		}(region)
	}

	wg.Wait()
	return results, nil
}

func (c *Client) getRegionCapacityBlocks(ctx context.Context, region string, opts CapacityBlockOptions) ([]CapacityBlockResult, error) {
	cfg := c.cfg
	cfg.Region = region
	client := ec2.NewFromConfig(cfg)

	// Build filters for DescribeCapacityBlockOfferings
	// Note: This API is for FINDING available blocks to reserve
	// For EXISTING reservations, we use DescribeCapacityReservations with specific filters
	
	// Get existing Capacity Block reservations
	// Capacity Blocks are a special type of Capacity Reservation
	filters := []types.Filter{
		{
			Name:   stringPtr("instance-type"),
			Values: opts.InstanceTypes,
		},
		{
			// Capacity Blocks have a specific reservation type
			Name:   stringPtr("capacity-reservation-type"),
			Values: []string{"capacity-block"},
		},
	}

	if opts.OnlyActive {
		filters = append(filters, types.Filter{
			Name:   stringPtr("state"),
			Values: []string{"active", "scheduled"},
		})
	}

	input := &ec2.DescribeCapacityReservationsInput{
		Filters: filters,
	}

	var results []CapacityBlockResult

	paginator := ec2.NewDescribeCapacityReservationsPaginator(client, input)
	for paginator.HasMorePages() {
		output, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}

		for _, cr := range output.CapacityReservations {
			// Capacity Blocks have specific characteristics
			// They have start/end dates and are co-located in UltraClusters
			
			startDate := ""
			if cr.StartDate != nil {
				startDate = cr.StartDate.Format(time.RFC3339)
			}
			
			endDate := ""
			durationHours := int32(0)
			if cr.EndDate != nil {
				endDate = cr.EndDate.Format(time.RFC3339)
				if cr.StartDate != nil {
					durationHours = int32(cr.EndDate.Sub(*cr.StartDate).Hours())
				}
			}

			// Filter by duration if specified
			if opts.MinDuration > 0 && durationHours < opts.MinDuration {
				continue
			}
			if opts.MaxDuration > 0 && durationHours > opts.MaxDuration {
				continue
			}

			result := CapacityBlockResult{
				CapacityBlockID:       valueOrZero(cr.CapacityReservationId),
				InstanceType:          valueOrZero(cr.InstanceType),
				InstanceCount:         valueOrZero(cr.TotalInstanceCount),
				AvailabilityZone:      valueOrZero(cr.AvailabilityZone),
				StartDate:             startDate,
				EndDate:               endDate,
				DurationHours:         durationHours,
				State:                 string(cr.State),
				UltraClusterPlacement: true, // Capacity Blocks are always in UltraClusters
			}

			// Extract tags
			for _, tag := range cr.Tags {
				if tag.Key != nil && tag.Value != nil {
					result.Tags = append(result.Tags, fmt.Sprintf("%s=%s", *tag.Key, *tag.Value))
				}
			}

			results = append(results, result)
		}
	}

	return results, nil
}
