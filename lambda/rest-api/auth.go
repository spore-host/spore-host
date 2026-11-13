package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"regexp"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Principal represents a validated API key caller.
type Principal struct {
	KeyID     string
	Project   string // "spore", "prism", etc.
	AccountID string // AWS account the key belongs to
	// UserKey is the chat identity (e.g. "slack#T…#U…") the key was issued
	// for, from the key row's user_key attribute. Empty for a key bound to no
	// identity. Only this identity's phone registration may be written with
	// the key (#698).
	UserKey   string
	CreatedAt time.Time
}

// keyStore is the subset of the DynamoDB client the key lookup uses, so the
// lookup can be tested without AWS.
type keyStore interface {
	GetItem(ctx context.Context, in *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	PutItem(ctx context.Context, in *dynamodb.PutItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	DeleteItem(ctx context.Context, in *dynamodb.DeleteItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
}

// rawKeyPattern is the shape of every key handed out: GenerateAPIKey's
// "sk_" + 48 hex, and DEPLOY.md's "sk_integ_" + 32 hex. Only a value of this
// shape may take the legacy plaintext fallback. A stored hash (64 hex) never
// has it, so presenting a hash read from the table can't reach the hashed row
// through the fallback (#697).
var rawKeyPattern = regexp.MustCompile(`^sk_[A-Za-z0-9_]{16,128}$`)

// keyFormatHashed marks a row whose partition key is the key's SHA-256. A row
// with this marker is never accepted through the plaintext fallback.
const keyFormatHashed = "sha256"

// hashKey returns the hex-encoded SHA-256 of an API key. Keys are stored and
// looked up by this hash so a table dump never yields usable credentials
// (#374). The hash is also the source of the truncated KeyID we log.
func hashKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// keyID returns a short, non-secret identifier for a key, safe to log. It is
// the first 8 hex chars of the key's SHA-256 — stable per key, but not
// reversible to the secret (unlike the old key[:8], which leaked the prefix).
func keyID(key string) string {
	return hashKey(key)[:8]
}

func validateAPIKey(ctx context.Context, key string) (*Principal, error) {
	table := os.Getenv("API_KEYS_TABLE")
	if table == "" {
		table = "spore-api-keys"
	}
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	if err != nil {
		return nil, err
	}
	return lookupAPIKey(ctx, dynamodb.NewFromConfig(cfg), table, key)
}

// lookupAPIKey resolves a presented key to its principal.
//
// Dual-read migration (#374): keys are stored hashed, but legacy rows still
// key on the plaintext. Look up by hash first; on a miss, and only for a value
// shaped like a raw key, fall back to the plaintext PK and, on a hit, rewrite
// the row to its hashed form so the plaintext copy disappears over time. New
// keys are only ever written hashed.
//
// The fallback used to take any value. Presenting a stored hash H then missed
// on sha256(H), found the hashed row under H, and "migrated" it to sha256(H):
// a table dump yielded working keys, and the real key stopped working (#697).
// Now only an sk_ key reaches the fallback, and a hit on a row that is
// already hashed (key_format=sha256, or a PK that is not raw-key shaped) is
// refused.
func lookupAPIKey(ctx context.Context, client keyStore, table, key string) (*Principal, error) {
	hashed := hashKey(key)
	item, err := getKeyItem(ctx, client, table, hashed)
	if err != nil {
		return nil, err
	}
	if item == nil {
		if !rawKeyPattern.MatchString(key) {
			return nil, fmt.Errorf("key not found")
		}
		item, err = getKeyItem(ctx, client, table, key)
		if err != nil {
			return nil, err
		}
		if item == nil || !isLegacyPlaintextRow(item, key) {
			return nil, fmt.Errorf("key not found")
		}
		// Best-effort migrate legacy plaintext row → hashed. A failure here must
		// not fail the request; the row is re-migrated on the next call.
		migrateKeyToHash(ctx, client, table, key, hashed, item)
	}

	get := func(k string) string {
		if v, ok := item[k].(*dynamodbtypes.AttributeValueMemberS); ok {
			return v.Value
		}
		return ""
	}

	// Check revoked
	if get("revoked") == "true" {
		return nil, fmt.Errorf("key revoked")
	}

	return &Principal{
		KeyID:     keyID(key),
		Project:   get("project"),
		AccountID: get("account_id"),
		UserKey:   get("user_key"),
	}, nil
}

// isLegacyPlaintextRow reports whether item, found by looking up the plaintext
// key, really is a legacy plaintext row for that key: its stored api_key is
// the key itself, in raw-key form, and it is not marked as hashed.
func isLegacyPlaintextRow(item map[string]dynamodbtypes.AttributeValue, key string) bool {
	if v, ok := item["key_format"].(*dynamodbtypes.AttributeValueMemberS); ok && v.Value == keyFormatHashed {
		return false
	}
	v, ok := item["api_key"].(*dynamodbtypes.AttributeValueMemberS)
	if !ok || !rawKeyPattern.MatchString(v.Value) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(v.Value), []byte(key)) == 1
}

// getKeyItem fetches the row whose api_key partition key equals pk (a hash or,
// for legacy rows, the plaintext key). Returns (nil, nil) when absent.
func getKeyItem(ctx context.Context, client keyStore, table, pk string) (map[string]dynamodbtypes.AttributeValue, error) {
	out, err := client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(table),
		Key: map[string]dynamodbtypes.AttributeValue{
			"api_key": &dynamodbtypes.AttributeValueMemberS{Value: pk},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("lookup api key: %w", err)
	}
	return out.Item, nil
}

// migrateKeyToHash rewrites a legacy plaintext-keyed row under its hashed PK and
// deletes the plaintext row. Best-effort: any error is logged and swallowed so a
// migration hiccup never blocks an otherwise-valid caller. The write is
// conditioned on the hashed row not already existing to avoid clobbering.
func migrateKeyToHash(ctx context.Context, client keyStore, table, plaintext, hashed string, item map[string]dynamodbtypes.AttributeValue) {
	// Guard against a corrupt row whose stored api_key isn't the plaintext we
	// looked up — hashing that would strand it under the wrong PK — and against
	// re-hashing a row that is already hashed (#697).
	if !isLegacyPlaintextRow(item, plaintext) {
		return
	}
	newItem := make(map[string]dynamodbtypes.AttributeValue, len(item))
	for k, v := range item {
		newItem[k] = v
	}
	newItem["api_key"] = &dynamodbtypes.AttributeValueMemberS{Value: hashed}
	newItem["key_format"] = &dynamodbtypes.AttributeValueMemberS{Value: keyFormatHashed}
	if _, err := client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(table),
		Item:                newItem,
		ConditionExpression: aws.String("attribute_not_exists(api_key)"),
	}); err != nil {
		// ConditionalCheckFailed means the hashed row already exists (a
		// concurrent migration) — fine; still drop the plaintext copy below.
		if !isConditionalCheckFailed(err) {
			log.Printf("api-key migrate: put hashed row failed for keyid=%s: %v", keyID(plaintext), err)
			return
		}
	}
	if _, err := client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(table),
		Key: map[string]dynamodbtypes.AttributeValue{
			"api_key": &dynamodbtypes.AttributeValueMemberS{Value: plaintext},
		},
	}); err != nil {
		log.Printf("api-key migrate: delete plaintext row failed for keyid=%s: %v", keyID(plaintext), err)
	}
}

func isConditionalCheckFailed(err error) bool {
	var cf *dynamodbtypes.ConditionalCheckFailedException
	return errors.As(err, &cf)
}

// GenerateAPIKey creates a new random API key (used by spawn api-key create).
func GenerateAPIKey() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "sk_" + hex.EncodeToString(b), nil
}
