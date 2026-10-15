// probe.go — turning AWS API outcomes into accountlifecycle.ProbeResults.
//
// The whole point of this file is that classification is separable from calling
// AWS. The state machine's refusals are only as good as the inputs it is handed:
// mislabel one AccessDenied and a healthy account is deprovisioned, no matter how
// carefully ApplyProbes guards its transitions. So the classification lives here,
// behind interfaces, and is unit-tested without a cloud.
package main

import (
	"context"
	"errors"
	"log"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/smithy-go"
	"github.com/spore-host/spore-host/lambda/accountlifecycle"
)

// managedTagFilter is the tag every spawn-launched instance carries. The prober
// asks only about spawn's own instances: an account full of unrelated EC2 is still
// "empty" for our purposes, and asking more broadly would need a wider grant in
// the customer's account than deciding our own lifecycle can justify.
const managedTagFilter = "tag:spawn:managed"

// ec2API is the slice of EC2 the prober uses — one call, so mocking is trivial.
type ec2API interface {
	DescribeInstances(ctx context.Context, in *ec2.DescribeInstancesInput, opts ...func(*ec2.Options)) (*ec2.DescribeInstancesOutput, error)
}

// regionalEC2 builds a client for one account+region, or returns an error if the
// credentials cannot be obtained at all (assume-role failure).
type regionalEC2 func(ctx context.Context, acct accountlifecycle.Account, region string) (ec2API, error)

// isDenied reports whether an AWS error is an authorization refusal. STS uses
// AccessDenied for both "the role is gone" and "your principal is not trusted" —
// deliberately, so as not to leak role existence. Resolving that ambiguity is
// ApplyProbes' job (it uses the account's LastSeenAt as the discriminator); here we
// only report faithfully which of the two error CLASSES we saw.
func isDenied(err error) bool {
	var ae smithy.APIError
	if !errors.As(err, &ae) {
		return false
	}
	switch ae.ErrorCode() {
	case "AccessDenied", "AccessDeniedException", "UnauthorizedOperation":
		return true
	default:
		return false
	}
}

// probeAccount produces one ProbeResult for one account by sweeping every region.
//
// The result's honesty about coverage is the load-bearing part. Dormancy means
// "reachable AND empty", and emptiness is established by finding nothing ANYWHERE
// a spore could be — so a sweep that skipped a region must say so, because
// zero-of-a-partial-set is not zero and dormant is a state that authorizes
// deleting the account's DNS records.
func probeAccount(ctx context.Context, acct accountlifecycle.Account, regions []string, mk regionalEC2) accountlifecycle.ProbeResult {
	res := accountlifecycle.ProbeResult{AccountID: acct.AccountID}

	var (
		reachedAny bool
		failedAny  bool
		denied     bool
	)
	for _, region := range regions {
		client, err := mk(ctx, acct, region)
		if err != nil {
			// An assume-role refusal is the same refusal in every region, so record it
			// once and stop: eleven identical AccessDenieds are one observation, and
			// hammering STS with the other ten helps nobody.
			if isDenied(err) {
				log.Printf("account %s: assume-role denied: %v", acct.AccountID, err)
				res.Reachable = false
				res.AssumeRoleDenied = true
				return res
			}
			log.Printf("account %s region %s: credentials unavailable: %v", acct.AccountID, region, err)
			failedAny = true
			continue
		}
		n, err := countManaged(ctx, client)
		if err != nil {
			if isDenied(err) {
				denied = true
			}
			log.Printf("account %s region %s: describe instances: %v", acct.AccountID, region, err)
			failedAny = true
			continue
		}
		reachedAny = true
		res.LiveInstances += n
	}

	// Reachability is proven by any region answering. Zero regions answering is a
	// failure — and if the API refused us, it is a refusal, which ApplyProbes then
	// weighs against this account's history rather than acting on directly.
	res.Reachable = reachedAny
	if !reachedAny {
		res.AssumeRoleDenied = denied
		return res
	}
	// Reached some regions but not all: liveness is proven, emptiness is not.
	res.EmptinessUnproven = failedAny
	return res
}

// countManaged counts non-terminated spawn-managed instances in one region.
//
// Stopped instances count as live: an idle-stopped spore is not evidence the
// account is unused, and treating it as such would deprovision an account whose
// user is simply between sessions. Only terminated/shutting-down are excluded,
// because those are already gone.
func countManaged(ctx context.Context, client ec2API) (int, error) {
	var count int
	pager := ec2.NewDescribeInstancesPaginator(client, &ec2.DescribeInstancesInput{
		Filters: []ec2types.Filter{
			{Name: aws.String(managedTagFilter), Values: []string{"true"}},
			{Name: aws.String("instance-state-name"), Values: []string{
				"pending", "running", "stopping", "stopped",
			}},
		},
	})
	for pager.HasMorePages() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			// Partial pages are discarded along with the count: a truncated count reads
			// as "emptier than reality", which is the direction that deprovisions.
			return 0, err
		}
		for _, r := range page.Reservations {
			count += len(r.Instances)
		}
	}
	return count, nil
}
