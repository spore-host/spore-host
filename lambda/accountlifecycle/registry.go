package accountlifecycle

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Account is one onboarded BYOA account's registration. AccountID is the
// partition key. Everything here is derived from the SigV4-verified caller
// except the ExternalId + Region the caller supplies.
type Account struct {
	AccountID    string `json:"accountId" dynamodbav:"accountId"`
	RoleArn      string `json:"roleArn" dynamodbav:"roleArn"`
	ExternalId   string `json:"externalId" dynamodbav:"externalId"`
	Region       string `json:"region" dynamodbav:"region"`
	RegisteredBy string `json:"registeredBy" dynamodbav:"registeredBy"`
	RegisteredAt string `json:"registeredAt" dynamodbav:"registeredAt"`

	// ── Lifecycle (spawn#457) ────────────────────────────────────────────────
	// Onboarding used to be one-way — PutAccount/GetAccount and nothing else — so
	// there was no state in which spore.host could ever conclude "this account is
	// gone". These fields make the registry the durable home of that judgment.
	// See lifecycle.go for the state machine that owns them.
	//
	// They are deliberately NOT set by the phone-home handler: registration only
	// ever means "reachable right now", and the reaper is what actually probes
	// every account every 10 minutes. omitempty throughout, so a row written
	// before this change unmarshals to the zero value and reads as StatusActive
	// via AccountStatus() — no backfill migration needed.

	// Status is the lifecycle state: "" (legacy, treated as active), or one of the
	// Status* constants in lifecycle.go.
	Status string `json:"status,omitempty" dynamodbav:"status,omitempty"`
	// LastSeenAt is the last time an assume-role into this account SUCCEEDED
	// (RFC3339) — the liveness signal. Distinct from RegisteredAt, which never
	// changes after onboarding.
	LastSeenAt string `json:"lastSeenAt,omitempty" dynamodbav:"lastSeenAt,omitempty"`
	// LastErrorAt/ConsecutiveFailures track the unreachable path. The counter is
	// what makes "K consecutive runs" durable: a stateless Lambda cannot otherwise
	// tell one blip from a sustained pattern.
	LastErrorAt         string `json:"lastErrorAt,omitempty" dynamodbav:"lastErrorAt,omitempty"`
	ConsecutiveFailures int    `json:"consecutiveFailures,omitempty" dynamodbav:"consecutiveFailures,omitempty"`
	// LastInstanceAt is the last time this account had a live managed instance.
	// Dormancy is "reachable AND empty for N days", which is only measurable
	// against a timestamp of last non-emptiness.
	LastInstanceAt string `json:"lastInstanceAt,omitempty" dynamodbav:"lastInstanceAt,omitempty"`
	// StatusReason is the human-readable why, for whoever reads the row.
	StatusReason string `json:"statusReason,omitempty" dynamodbav:"statusReason,omitempty"`
	// StatusChangedAt is when Status last transitioned (RFC3339).
	StatusChangedAt string `json:"statusChangedAt,omitempty" dynamodbav:"statusChangedAt,omitempty"`
}

type Registry struct {
	client       *dynamodb.Client
	accountTable string
}

// NewRegistry builds a Registry against ACCOUNTS_TABLE (default
// spore-portal-accounts). Shared by the phone-home registrar (which writes
// registrations) and the account prober (which writes lifecycle transitions).
func NewRegistry(cfg aws.Config) *Registry {
	table := os.Getenv("ACCOUNTS_TABLE")
	if table == "" {
		table = "spore-portal-accounts"
	}
	return &Registry{
		client:       dynamodb.NewFromConfig(cfg),
		accountTable: table,
	}
}

// PutAccount upserts a registration. Re-onboarding the same account overwrites
// the prior row (a fresh ExternalId/role supersedes the old one).
func (r *Registry) PutAccount(ctx context.Context, acct *Account) error {
	if acct.RegisteredAt == "" {
		acct.RegisteredAt = time.Now().UTC().Format(time.RFC3339)
	}
	item, err := attributevalue.MarshalMap(acct)
	if err != nil {
		return fmt.Errorf("marshal account: %w", err)
	}
	_, err = r.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(r.accountTable),
		Item:      item,
	})
	if err != nil {
		return fmt.Errorf("put item: %w", err)
	}
	return nil
}

// GetAccount fetches a registration by account id (used by the portal/tests).
func (r *Registry) GetAccount(ctx context.Context, accountID string) (*Account, error) {
	out, err := r.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(r.accountTable),
		Key: map[string]dynamodbtypes.AttributeValue{
			"accountId": &dynamodbtypes.AttributeValueMemberS{Value: accountID},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("get item: %w", err)
	}
	if out.Item == nil {
		return nil, nil
	}
	var acct Account
	if err := attributevalue.UnmarshalMap(out.Item, &acct); err != nil {
		return nil, fmt.Errorf("unmarshal account: %w", err)
	}
	return &acct, nil
}

// ListAccounts returns every registration. The reaper needs the whole set per run
// to feed ApplyProbes, and the table holds one row per onboarded account — tens,
// not millions — so a Scan is the right shape here. Paginated anyway: a truncated
// Scan would silently look like "these accounts no longer exist", the exact class
// of false conclusion this lifecycle work exists to avoid.
func (r *Registry) ListAccounts(ctx context.Context) ([]Account, error) {
	var out []Account
	var start map[string]dynamodbtypes.AttributeValue
	for {
		page, err := r.client.Scan(ctx, &dynamodb.ScanInput{
			TableName:         aws.String(r.accountTable),
			ExclusiveStartKey: start,
		})
		if err != nil {
			return nil, fmt.Errorf("scan accounts: %w", err)
		}
		var batch []Account
		if err := attributevalue.UnmarshalListOfMaps(page.Items, &batch); err != nil {
			return nil, fmt.Errorf("unmarshal accounts: %w", err)
		}
		out = append(out, batch...)
		if len(page.LastEvaluatedKey) == 0 {
			return out, nil
		}
		start = page.LastEvaluatedKey
	}
}

// UpdateLifecycle persists ONLY the lifecycle fields (spawn#457), leaving the
// registration — roleArn, externalId, region, registeredBy/At — untouched.
//
// An UpdateItem rather than PutAccount, and that distinction is load-bearing in
// two directions. A Put would clobber a concurrent re-onboard's fresh
// ExternalId/roleArn with the copy this reaper run happened to read; and because
// UpdateItem upserts, a Put would also resurrect a row for an account that was
// deliberately deleted between the Scan and the write. Only the fields the state
// machine owns are written.
//
// "status" is a DynamoDB reserved word, hence the #s alias.
func (r *Registry) UpdateLifecycle(ctx context.Context, acct *Account) error {
	if acct == nil || acct.AccountID == "" {
		return fmt.Errorf("UpdateLifecycle: accountId is required")
	}
	names := map[string]string{"#s": "status"}
	values := map[string]dynamodbtypes.AttributeValue{
		":s":  &dynamodbtypes.AttributeValueMemberS{Value: acct.AccountStatus()},
		":cf": &dynamodbtypes.AttributeValueMemberN{Value: strconv.Itoa(acct.ConsecutiveFailures)},
	}
	set := []string{"#s = :s", "consecutiveFailures = :cf"}

	// The timestamps are set only when non-empty: writing an empty string would
	// replace a real prior value with one that parses as neither a time nor
	// "absent", and the dormancy math reads these back.
	for alias, pair := range map[string]struct{ attr, val string }{
		":ls":  {"lastSeenAt", acct.LastSeenAt},
		":le":  {"lastErrorAt", acct.LastErrorAt},
		":li":  {"lastInstanceAt", acct.LastInstanceAt},
		":sr":  {"statusReason", acct.StatusReason},
		":sca": {"statusChangedAt", acct.StatusChangedAt},
	} {
		if pair.val == "" {
			continue
		}
		values[alias] = &dynamodbtypes.AttributeValueMemberS{Value: pair.val}
		set = append(set, pair.attr+" = "+alias)
	}
	// Deterministic expression order — map iteration is randomized, and a stable
	// string keeps logs and test assertions readable.
	sort.Strings(set)

	_, err := r.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(r.accountTable),
		Key: map[string]dynamodbtypes.AttributeValue{
			"accountId": &dynamodbtypes.AttributeValueMemberS{Value: acct.AccountID},
		},
		UpdateExpression:          aws.String("SET " + strings.Join(set, ", ")),
		ExpressionAttributeNames:  names,
		ExpressionAttributeValues: values,
	})
	if err != nil {
		return fmt.Errorf("update lifecycle for %s: %w", acct.AccountID, err)
	}
	return nil
}

// Offboard marks an account offboarded — the explicit, human-initiated
// deprovision. Unlike every other transition this one is stated rather than
// inferred, which is exactly why it is the only path (besides proven dormancy)
// that makes an account's DNS records eligible for deletion.
func (r *Registry) Offboard(ctx context.Context, accountID, by string, now time.Time) error {
	if accountID == "" {
		return fmt.Errorf("Offboard: accountId is required")
	}
	stamp := now.UTC().Format(time.RFC3339)
	return r.UpdateLifecycle(ctx, &Account{
		AccountID:       accountID,
		Status:          StatusOffboarded,
		StatusReason:    "offboarded by " + by,
		StatusChangedAt: stamp,
	})
}
