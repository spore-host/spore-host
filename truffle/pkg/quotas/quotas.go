// Package quotas queries AWS Service Quotas and current EC2 usage to determine
// whether a given instance type can be launched under an account's limits.
//
// EC2 service quotas are expressed as per-family vCPU counts rather than
// instance counts. This package handles the mapping from instance type to
// quota family (e.g., p4d.24xlarge → FamilyP) and computes remaining capacity.
//
// Typical usage:
//
//	client, err := quotas.NewClient(ctx)
//	info, err := client.GetQuotas(ctx, "us-east-1")
//	ok, msg := client.CanLaunch("p4d.24xlarge", 96, info, false)
//
// Results are cached per region for 5 minutes to avoid redundant API calls.
package quotas

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/aws-sdk-go-v2/service/servicequotas"
)

// QuotaFamily represents instance family groupings for Service Quotas
type QuotaFamily string

const (
	FamilyStandard QuotaFamily = "Standard" // A, C, D, H, I, M, R, T, Z
	FamilyF        QuotaFamily = "F"        // FPGA
	FamilyG        QuotaFamily = "G"        // Graphics (g4dn, g5, g6)
	FamilyP        QuotaFamily = "P"        // GPU Training (p3, p4, p5)
	FamilyX        QuotaFamily = "X"        // Memory optimized
	FamilyInf      QuotaFamily = "Inf"      // Inferentia
	FamilyTrn      QuotaFamily = "Trn"      // Trainium
)

// Service Quota codes for EC2
const (
	// On-Demand vCPU quotas
	QuotaCodeStandard = "L-1216C47A" // Running On-Demand Standard instances
	QuotaCodeF        = "L-74FC7D96" // Running On-Demand F instances
	QuotaCodeG        = "L-DB2E81BA" // Running On-Demand G instances
	QuotaCodeP        = "L-417A185B" // Running On-Demand P instances
	QuotaCodeX        = "L-7295265B" // Running On-Demand X instances
	QuotaCodeInf      = "L-1945791B" // Running On-Demand Inf instances
	QuotaCodeTrn      = "L-2C3B7624" // Running On-Demand Trn instances

	// Spot vCPU quotas
	QuotaCodeSpotStandard = "L-34B43A08" // All Standard Spot Instance Requests
	QuotaCodeSpotF        = "L-88CF9481" // All F Spot Instance Requests
	QuotaCodeSpotG        = "L-3819A6DF" // All G and VT Spot Instance Requests
	QuotaCodeSpotP        = "L-7212CCBC" // All P Spot Instance Requests
	QuotaCodeSpotX        = "L-E3A00192" // All X Spot Instance Requests
	QuotaCodeSpotInf      = "L-B5D1601B" // All Inf Spot Instance Requests
	QuotaCodeSpotTrn      = "L-5480EFD2" // All Trn Spot Instance Requests
)

// QuotaInfo holds quota limits and current usage for a single region,
// as returned by [Client.GetQuotas].
type QuotaInfo struct {
	Region string // AWS region this snapshot covers, e.g. "us-east-1"

	// On-Demand quotas — maximum vCPUs per family
	OnDemand map[QuotaFamily]int32

	// Spot quotas — maximum vCPUs per family for Spot instances
	Spot map[QuotaFamily]int32

	// Current usage — vCPUs currently in use (running + pending) per family
	Usage map[QuotaFamily]int32

	RunningInstances    int32     // Current count of running+pending instances in this region
	RunningInstancesMax int32     // Per-region instance count limit (typically 20 for new accounts)
	LastUpdated         time.Time // When this snapshot was fetched
	CredentialsAvailable bool     // False when quotas were estimated due to missing credentials
}

// Client handles quota operations
type Client struct {
	sqClient  *servicequotas.Client
	ec2Client *ec2.Client
	baseCfg   aws.Config
	cache     map[string]*QuotaInfo
	cacheMu   sync.RWMutex
	cacheTTL  time.Duration
}

// NewClient creates a quota client using the default credential chain.
// Returns error if AWS credentials are not available.
func NewClient(ctx context.Context) (*Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithDefaultRegion("us-east-1"),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config (credentials required for quota checking): %w", err)
	}
	return NewClientFromConfig(cfg), nil
}

// NewClientFromConfig creates a quota client with an injected AWS config.
// Use this in tests to point the client at a Substrate emulator.
func NewClientFromConfig(cfg aws.Config) *Client {
	return &Client{
		sqClient:  servicequotas.NewFromConfig(cfg),
		ec2Client: ec2.NewFromConfig(cfg),
		baseCfg:   cfg,
		cache:     make(map[string]*QuotaInfo),
		cacheTTL:  5 * time.Minute,
	}
}

// GetQuotas retrieves quota information for a region
func (c *Client) GetQuotas(ctx context.Context, region string) (*QuotaInfo, error) {
	// Check cache
	c.cacheMu.RLock()
	if cached, ok := c.cache[region]; ok {
		if time.Since(cached.LastUpdated) < c.cacheTTL {
			c.cacheMu.RUnlock()
			return cached, nil
		}
	}
	c.cacheMu.RUnlock()

	// Fetch fresh data
	info := &QuotaInfo{
		Region:               region,
		OnDemand:             make(map[QuotaFamily]int32),
		Spot:                 make(map[QuotaFamily]int32),
		Usage:                make(map[QuotaFamily]int32),
		LastUpdated:          time.Now(),
		CredentialsAvailable: true,
	}

	// Get On-Demand quotas
	quotas := map[QuotaFamily]string{
		FamilyStandard: QuotaCodeStandard,
		FamilyF:        QuotaCodeF,
		FamilyG:        QuotaCodeG,
		FamilyP:        QuotaCodeP,
		FamilyX:        QuotaCodeX,
		FamilyInf:      QuotaCodeInf,
		FamilyTrn:      QuotaCodeTrn,
	}

	for family, code := range quotas {
		value, err := c.getQuotaValue(ctx, region, code)
		if err != nil {
			// Log but don't fail - some quotas might not exist
			continue
		}
		info.OnDemand[family] = value
	}

	// Get Spot quotas
	spotQuotas := map[QuotaFamily]string{
		FamilyStandard: QuotaCodeSpotStandard,
		FamilyF:        QuotaCodeSpotF,
		FamilyG:        QuotaCodeSpotG,
		FamilyP:        QuotaCodeSpotP,
		FamilyX:        QuotaCodeSpotX,
		FamilyInf:      QuotaCodeSpotInf,
		FamilyTrn:      QuotaCodeSpotTrn,
	}

	for family, code := range spotQuotas {
		value, err := c.getQuotaValue(ctx, region, code)
		if err != nil {
			continue
		}
		info.Spot[family] = value
	}

	// Get current usage
	usage, err := c.getCurrentUsage(ctx, region)
	if err != nil {
		return nil, fmt.Errorf("failed to get current usage: %w", err)
	}
	info.Usage = usage

	// Get running instance count
	runningCount, err := c.getRunningInstanceCount(ctx, region)
	if err == nil {
		info.RunningInstances = runningCount
	}
	
	// Running instances quota is typically 20 by default
	info.RunningInstancesMax = 20 // Could query this too

	// Cache result
	c.cacheMu.Lock()
	c.cache[region] = info
	c.cacheMu.Unlock()

	return info, nil
}

// getQuotaValue retrieves a specific quota value
func (c *Client) getQuotaValue(ctx context.Context, region, quotaCode string) (int32, error) {
	// Clone base config with region override.
	cfg := c.baseCfg
	cfg.Region = region
	sqClient := servicequotas.NewFromConfig(cfg)

	output, err := sqClient.GetServiceQuota(ctx, &servicequotas.GetServiceQuotaInput{
		ServiceCode: aws.String("ec2"),
		QuotaCode:   aws.String(quotaCode),
	})
	if err != nil {
		return 0, err
	}

	if output.Quota != nil && output.Quota.Value != nil {
		return int32(*output.Quota.Value), nil
	}

	return 0, fmt.Errorf("quota value not found")
}

// getCurrentUsage calculates current vCPU usage by family
func (c *Client) getCurrentUsage(ctx context.Context, region string) (map[QuotaFamily]int32, error) {
	cfg := c.baseCfg
	cfg.Region = region
	ec2Client := ec2.NewFromConfig(cfg)

	// Get running instances
	output, err := ec2Client.DescribeInstances(ctx, &ec2.DescribeInstancesInput{
		Filters: []ec2types.Filter{
			{
				Name:   aws.String("instance-state-name"),
				Values: []string{"running", "pending"},
			},
		},
	})
	if err != nil {
		return nil, err
	}

	usage := make(map[QuotaFamily]int32)

	for _, reservation := range output.Reservations {
		for _, instance := range reservation.Instances {
			if instance.InstanceType == "" {
				continue
			}

			instanceType := string(instance.InstanceType)
			family := GetQuotaFamily(instanceType)

			// Get vCPU count for instance type
			vCPUs := getVCPUCount(instanceType)
			usage[family] += vCPUs
		}
	}

	return usage, nil
}

// getRunningInstanceCount returns the number of running instances
func (c *Client) getRunningInstanceCount(ctx context.Context, region string) (int32, error) {
	cfg := c.baseCfg
	cfg.Region = region
	ec2Client := ec2.NewFromConfig(cfg)

	output, err := ec2Client.DescribeInstances(ctx, &ec2.DescribeInstancesInput{
		Filters: []ec2types.Filter{
			{
				Name:   aws.String("instance-state-name"),
				Values: []string{"running", "pending"},
			},
		},
	})
	if err != nil {
		return 0, err
	}

	count := int32(0)
	for _, reservation := range output.Reservations {
		count += int32(len(reservation.Instances))
	}

	return count, nil
}

// CanLaunch checks if an instance can be launched given quotas
func (c *Client) CanLaunch(instanceType string, vCPUs int32, quotas *QuotaInfo, spot bool) (bool, string) {
	family := GetQuotaFamily(instanceType)

	var quota, usage int32
	var quotaType string

	if spot {
		quota = quotas.Spot[family]
		quotaType = "Spot"
	} else {
		quota = quotas.OnDemand[family]
		usage = quotas.Usage[family]
		quotaType = "On-Demand"
	}

	available := quota - usage

	if quota == 0 {
		return false, fmt.Sprintf("%s quota for %s instances is 0 (request quota increase)", quotaType, family)
	}

	if vCPUs > available {
		return false, fmt.Sprintf("Need %d vCPUs, only %d available (%s %s: quota=%d, usage=%d)",
			vCPUs, available, quotaType, family, quota, usage)
	}

	return true, ""
}

// GetQuotaFamily maps instance type to quota family
func GetQuotaFamily(instanceType string) QuotaFamily {
	// Extract family prefix (e.g., "p5" from "p5.48xlarge")
	parts := strings.Split(instanceType, ".")
	if len(parts) == 0 {
		return FamilyStandard
	}

	prefix := parts[0]

	// P instances (GPU training)
	if strings.HasPrefix(prefix, "p") {
		return FamilyP
	}

	// G instances (Graphics/GPU)
	if strings.HasPrefix(prefix, "g") {
		return FamilyG
	}

	// Inf instances (Inferentia)
	if strings.HasPrefix(prefix, "inf") {
		return FamilyInf
	}

	// Trn instances (Trainium)
	if strings.HasPrefix(prefix, "trn") {
		return FamilyTrn
	}

	// F instances (FPGA)
	if strings.HasPrefix(prefix, "f") {
		return FamilyF
	}

	// X instances (Memory)
	if strings.HasPrefix(prefix, "x") {
		return FamilyX
	}

	// Default to Standard (A, C, D, H, I, M, R, T, Z)
	return FamilyStandard
}

// getVCPUCount estimates vCPU count from instance type
// This is a simplified estimation - in production, query DescribeInstanceTypes
func getVCPUCount(instanceType string) int32 {
	// Parse size suffix (nano, micro, small, medium, large, xlarge, 2xlarge, etc.)
	parts := strings.Split(instanceType, ".")
	if len(parts) < 2 {
		return 2 // Default
	}

	size := parts[1]

	switch size {
	case "nano":
		return 1
	case "micro":
		return 1
	case "small":
		return 1
	case "medium":
		return 1
	case "large":
		return 2
	case "xlarge":
		return 4
	case "2xlarge":
		return 8
	case "3xlarge":
		return 12
	case "4xlarge":
		return 16
	case "6xlarge":
		return 24
	case "8xlarge":
		return 32
	case "9xlarge":
		return 36
	case "10xlarge":
		return 40
	case "12xlarge":
		return 48
	case "16xlarge":
		return 64
	case "18xlarge":
		return 72
	case "24xlarge":
		return 96
	case "32xlarge":
		return 128
	case "48xlarge":
		return 192
	case "56xlarge":
		return 224
	case "112xlarge":
		return 448
	}

	// Try to parse numeric prefix (e.g., "2xlarge" → 2)
	if strings.HasSuffix(size, "xlarge") {
		numStr := strings.TrimSuffix(size, "xlarge")
		if num := parseInt(numStr); num > 0 {
			return num * 4
		}
	}

	return 2 // Default
}

func parseInt(s string) int32 {
	var result int32
	_, _ = fmt.Sscanf(s, "%d", &result)
	return result
}

// QuotaIncreaseCommand generates AWS CLI command to request quota increase
func QuotaIncreaseCommand(region string, family QuotaFamily, desiredValue int32, spot bool) string {
	quotaCode := QuotaCodeStandard
	quotaName := "Standard On-Demand"

	if spot {
		switch family {
		case FamilyStandard:
			quotaCode = QuotaCodeSpotStandard
			quotaName = "Standard Spot"
		case FamilyG:
			quotaCode = QuotaCodeSpotG
			quotaName = "G Spot"
		case FamilyP:
			quotaCode = QuotaCodeSpotP
			quotaName = "P Spot"
		}
	} else {
		switch family {
		case FamilyStandard:
			quotaCode = QuotaCodeStandard
			quotaName = "Standard On-Demand"
		case FamilyG:
			quotaCode = QuotaCodeG
			quotaName = "G On-Demand"
		case FamilyP:
			quotaCode = QuotaCodeP
			quotaName = "P On-Demand"
		case FamilyInf:
			quotaCode = QuotaCodeInf
			quotaName = "Inf On-Demand"
		case FamilyTrn:
			quotaCode = QuotaCodeTrn
			quotaName = "Trn On-Demand"
		}
	}

	return fmt.Sprintf(`# Request %s quota increase to %d vCPUs
aws service-quotas request-service-quota-increase \
  --service-code ec2 \
  --quota-code %s \
  --desired-value %d \
  --region %s

# Check status:
aws service-quotas list-requested-service-quota-change-history-by-quota \
  --service-code ec2 \
  --quota-code %s \
  --region %s`,
		quotaName, desiredValue, quotaCode, desiredValue, region, quotaCode, region)
}
