# Go Library

The truffle and spawn packages are clean, importable Go libraries. Use them in your own tools, services, or orchestration code without calling CLI subprocesses.

## Installation

Each tool lives in its own Go module. Add only the packages you need:

```sh
# Instance type discovery
go get github.com/spore-host/spore-host/truffle

# Instance lifecycle management
go get github.com/spore-host/spore-host/spawn
```

Both modules require Go 1.21+ and load AWS credentials from the standard chain (`AWS_*` environment variables, `~/.aws/credentials`, or EC2/ECS metadata).

## Authentication

No extra configuration is needed beyond standard AWS credentials:

```go
import (
    truffleaws "github.com/spore-host/spore-host/truffle/pkg/aws"
    spawnclient "github.com/spore-host/spore-host/spawn/pkg/aws"
)

// Both use the same credential chain as the AWS CLI
tClient, err := truffleaws.NewClient(ctx)
sClient, err := spawnclient.NewClient(ctx)
```

To use a specific profile, set `AWS_PROFILE` in the environment before calling `NewClient`, or build an `aws.Config` manually and pass it to `NewClientFromConfig`.

## truffle — EC2 capacity discovery

### Natural language search

```go
import (
    truffleaws "github.com/spore-host/spore-host/truffle/pkg/aws"
    "github.com/spore-host/spore-host/truffle/pkg/find"
)

// Parse a free-text query into structured criteria
pq, err := find.ParseQuery("amd epyc genoa 16 cores")
criteria, err := pq.BuildCriteria()

client, err := truffleaws.NewClient(ctx)

// Search one or more regions
results, err := client.SearchInstanceTypes(
    ctx,
    []string{"us-east-1", "us-west-2"},
    criteria.InstanceTypePattern,
    criteria.FilterOptions,
)

for _, r := range results {
    fmt.Printf("%s  %d vCPU  %.0f GiB  $%.4f/hr\n",
        r.InstanceType, r.VCPUs, float64(r.MemoryMiB)/1024, r.OnDemandPrice)

    // Optional: explain why this instance matched
    reasons := find.ExplainMatch(r, pq)
    fmt.Println(" ", strings.Join(reasons, ", "))
}
```

Supported query terms: vendor names (`intel`, `amd`, `graviton`), processor code names (`genoa`, `ice lake`, `sapphire rapids`), GPU models (`h100`, `a100`, `l4`), size descriptions (`large`, `xlarge`, `huge`), numeric constraints (`32 cores`, `128gb`), architecture (`arm64`, `x86_64`), and network (`efa`, `100gbps`).

### Spot prices

```go
prices, err := client.GetSpotPricing(ctx, results, truffleaws.SpotOptions{
    ShowSavings: true, // populate SavingsPercent field
})

cheapest := prices[0]
for _, p := range prices {
    if p.SpotPrice < cheapest.SpotPrice {
        cheapest = p
    }
}
fmt.Printf("Cheapest: %s %s $%.4f/hr (%.0f%% savings)\n",
    cheapest.InstanceType, cheapest.AvailabilityZone,
    cheapest.SpotPrice, cheapest.SavingsPercent)
```

### Quota check

```go
import "github.com/spore-host/spore-host/truffle/pkg/quotas"

qc, err := quotas.NewClient(ctx)
info, err := qc.GetQuotas(ctx, "us-east-1")

// Check whether 96 vCPUs of p4d.24xlarge can launch (on-demand)
ok, msg := qc.CanLaunch("p4d.24xlarge", 96, info, false)
if !ok {
    fmt.Println("Cannot launch:", msg)
    // Generate an AWS CLI command to request a quota increase
    cmd := quotas.QuotaIncreaseCommand("us-east-1", quotas.GetQuotaFamily("p4d.24xlarge"), 192, false)
    fmt.Println("Request increase with:", cmd)
}
```

## spawn — instance lifecycle management

### List and status

```go
client, err := spawnclient.NewClient(ctx)

// List all running instances across all regions
instances, err := client.ListInstances(ctx, "", "running")
for _, inst := range instances {
    fmt.Printf("%s  %s  %s  TTL:%s\n",
        inst.Name, inst.InstanceType, inst.State, inst.TTL)
}

// Single instance status (by name or ID)
state, err := client.GetInstanceState(ctx, "us-east-1", "i-0abc123def456")
```

### Stop, start, terminate, extend

```go
// Stop (preserves instance, stops billing for compute)
err = client.StopInstance(ctx, "us-east-1", "i-0abc123def456", false)

// Hibernate (saves RAM to disk, faster resume than stop)
err = client.StopInstance(ctx, "us-east-1", "i-0abc123def456", true)

// Start a stopped or hibernated instance
err = client.StartInstance(ctx, "us-east-1", "i-0abc123def456")

// Terminate permanently
err = client.Terminate(ctx, "us-east-1", "i-0abc123def456")

// Extend TTL — pushes the absolute deadline forward, never resets from now
err = client.UpdateInstanceTags(ctx, "us-east-1", "i-0abc123def456",
    map[string]string{"spawn:ttl": "4h"})
```

### Launch

```go
result, err := client.Launch(ctx, spawnclient.LaunchConfig{
    Name:         "my-analysis",
    InstanceType: "c8a.2xlarge",
    Region:       "us-east-1",
    AMI:          "ami-0c55b159cbfafe1f0",
    KeyName:      "my-key",
    TTL:          "8h",
    IdleTimeout:  "30m",   // stops if idle; resets on each wake
    OnComplete:   "terminate",
})
fmt.Printf("Launched %s at %s\n", result.InstanceID, result.PublicIP)
```

::: tip TTL vs idle timeout
`TTL` is the hard deadline, anchored to the original launch time and never reset by stop/wake cycles. `IdleTimeout` stops the instance when idle — the timer resets on each wake. Only TTL causes termination. See [TTL vs idle timeout](/reference/configuration#ttl-vs-idle-timeout-how-they-interact).
:::

## Combined workflow

A typical pattern for automated research pipelines:

```go
// 1. Find the cheapest GPU instance with enough memory
pq, _ := find.ParseQuery("nvidia a100 40gb")
criteria, _ := pq.BuildCriteria()
tc, _ := truffleaws.NewClient(ctx)
results, _ := tc.SearchInstanceTypes(ctx, []string{"us-east-1"}, criteria.InstanceTypePattern, criteria.FilterOptions)

// 2. Check quota before committing
qc, _ := quotas.NewClient(ctx)
info, _ := qc.GetQuotas(ctx, "us-east-1")
if ok, _ := qc.CanLaunch(results[0].InstanceType, results[0].VCPUs, info, false); !ok {
    log.Fatal("insufficient quota")
}

// 3. Launch with TTL and idle protection
sc, _ := spawnclient.NewClient(ctx)
r, _ := sc.Launch(ctx, spawnclient.LaunchConfig{
    Name:         "training-run",
    InstanceType: results[0].InstanceType,
    Region:       results[0].Region,
    TTL:          "12h",
    IdleTimeout:  "30m",
    OnComplete:   "terminate",
    CompletionFile: "/tmp/SPAWN_COMPLETE",
})
fmt.Printf("Running: %s\n", r.InstanceID)
```

## API reference

Full API documentation is on pkg.go.dev:

- [truffle/pkg/aws](https://pkg.go.dev/github.com/spore-host/spore-host/truffle/pkg/aws) — `Client`, `InstanceTypeResult`, `SpotPriceResult`, `FilterOptions`, `SpotOptions`
- [truffle/pkg/find](https://pkg.go.dev/github.com/spore-host/spore-host/truffle/pkg/find) — `ParseQuery`, `ParsedQuery`, `SearchCriteria`, `FindResult`, `ExplainMatch`
- [truffle/pkg/quotas](https://pkg.go.dev/github.com/spore-host/spore-host/truffle/pkg/quotas) — `Client`, `QuotaInfo`, `CanLaunch`, `GetQuotaFamily`
- [spawn/pkg/aws](https://pkg.go.dev/github.com/spore-host/spore-host/spawn/pkg/aws) — `Client`, `LaunchConfig`, `LaunchResult`, `InstanceInfo`

## Real-world usage

[prism](https://prismcloud.host) uses both spawn and truffle as Go libraries to manage RStudio and Jupyter environments for university research teams, without maintaining its own EC2 tooling.
