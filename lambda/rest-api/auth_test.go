package main

import (
	"context"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// fakeKeyStore is an in-memory spore-api-keys table keyed by api_key.
type fakeKeyStore struct {
	rows map[string]map[string]dynamodbtypes.AttributeValue
}

func newFakeKeyStore() *fakeKeyStore {
	return &fakeKeyStore{rows: map[string]map[string]dynamodbtypes.AttributeValue{}}
}

func pk(in map[string]dynamodbtypes.AttributeValue) string {
	return in["api_key"].(*dynamodbtypes.AttributeValueMemberS).Value
}

func (f *fakeKeyStore) GetItem(_ context.Context, in *dynamodb.GetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	return &dynamodb.GetItemOutput{Item: f.rows[pk(in.Key)]}, nil
}

func (f *fakeKeyStore) PutItem(_ context.Context, in *dynamodb.PutItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	k := pk(in.Item)
	if in.ConditionExpression != nil {
		if _, exists := f.rows[k]; exists {
			return nil, &dynamodbtypes.ConditionalCheckFailedException{}
		}
	}
	f.rows[k] = in.Item
	return &dynamodb.PutItemOutput{}, nil
}

func (f *fakeKeyStore) DeleteItem(_ context.Context, in *dynamodb.DeleteItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	delete(f.rows, pk(in.Key))
	return &dynamodb.DeleteItemOutput{}, nil
}

func (f *fakeKeyStore) put(pkVal string, attrs map[string]string) {
	row := map[string]dynamodbtypes.AttributeValue{"api_key": &dynamodbtypes.AttributeValueMemberS{Value: pkVal}}
	for k, v := range attrs {
		row[k] = &dynamodbtypes.AttributeValueMemberS{Value: v}
	}
	f.rows[pkVal] = row
}

const testRawKey = "sk_0123456789abcdef0123456789abcdef0123456789abcdef"

func TestLookupAPIKey_HashedRow(t *testing.T) {
	s := newFakeKeyStore()
	s.put(hashKey(testRawKey), map[string]string{"project": "acme", "user_key": "slack#T1#U1", "key_format": keyFormatHashed})

	p, err := lookupAPIKey(context.Background(), s, "t", testRawKey)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if p.Project != "acme" || p.UserKey != "slack#T1#U1" || p.KeyID != keyID(testRawKey) {
		t.Errorf("principal = %+v", p)
	}
}

// #697: the stored hash must not work as a key, and presenting it must not
// re-key the row so that the real key stops working.
func TestLookupAPIKey_StoredHashIsNotAKey(t *testing.T) {
	for _, format := range []string{keyFormatHashed, ""} { // marked, and a row written before the marker
		t.Run("key_format="+format, func(t *testing.T) {
			s := newFakeKeyStore()
			h := hashKey(testRawKey)
			attrs := map[string]string{"project": "acme"}
			if format != "" {
				attrs["key_format"] = format
			}
			s.put(h, attrs)

			if p, err := lookupAPIKey(context.Background(), s, "t", h); err == nil {
				t.Fatalf("the stored hash authenticated as %+v", p)
			}
			if len(s.rows) != 1 || s.rows[h] == nil {
				t.Fatalf("presenting the hash changed the table: %v", s.rows)
			}
			if _, err := lookupAPIKey(context.Background(), s, "t", testRawKey); err != nil {
				t.Errorf("the real key stopped working: %v", err)
			}
		})
	}
}

func TestLookupAPIKey_LegacyPlaintextMigrates(t *testing.T) {
	for _, key := range []string{testRawKey, "sk_integ_0123456789abcdef0123456789abcdef"} {
		t.Run(key[:9], func(t *testing.T) {
			s := newFakeKeyStore()
			s.put(key, map[string]string{"project": "acme"})

			if _, err := lookupAPIKey(context.Background(), s, "t", key); err != nil {
				t.Fatalf("legacy key: %v", err)
			}
			if _, still := s.rows[key]; still {
				t.Error("plaintext row not removed")
			}
			row := s.rows[hashKey(key)]
			if row == nil {
				t.Fatal("hashed row not written")
			}
			if f, _ := row["key_format"].(*dynamodbtypes.AttributeValueMemberS); f == nil || f.Value != keyFormatHashed {
				t.Errorf("migrated row not marked key_format=%s", keyFormatHashed)
			}
			if _, err := lookupAPIKey(context.Background(), s, "t", key); err != nil {
				t.Errorf("key fails after migration: %v", err)
			}
		})
	}
}

func TestLookupAPIKey_FallbackRefusals(t *testing.T) {
	t.Run("value not shaped like a key never reaches the fallback", func(t *testing.T) {
		s := newFakeKeyStore()
		s.put("not-a-key", map[string]string{"project": "acme"})
		if _, err := lookupAPIKey(context.Background(), s, "t", "not-a-key"); err == nil {
			t.Error("non-sk_ value authenticated through the plaintext fallback")
		}
	})
	t.Run("row marked hashed is refused even under a key-shaped PK", func(t *testing.T) {
		s := newFakeKeyStore()
		s.put(testRawKey, map[string]string{"project": "acme", "key_format": keyFormatHashed})
		if _, err := lookupAPIKey(context.Background(), s, "t", testRawKey); err == nil {
			t.Error("row marked key_format=sha256 accepted through the fallback")
		}
		if s.rows[hashKey(testRawKey)] != nil {
			t.Error("marked row was migrated")
		}
	})
	t.Run("unknown key", func(t *testing.T) {
		if _, err := lookupAPIKey(context.Background(), newFakeKeyStore(), "t", testRawKey); err == nil {
			t.Error("unknown key authenticated")
		}
	})
	t.Run("revoked", func(t *testing.T) {
		s := newFakeKeyStore()
		s.put(hashKey(testRawKey), map[string]string{"project": "acme", "revoked": "true"})
		if _, err := lookupAPIKey(context.Background(), s, "t", testRawKey); err == nil {
			t.Error("revoked key authenticated")
		}
	})
}

func TestRawKeyPattern(t *testing.T) {
	ok := []string{testRawKey, "sk_integ_0123456789abcdef0123456789abcdef"}
	bad := []string{"", hashKey(testRawKey), "sk_", "sk_short", "SK_0123456789abcdef0123", "sk_0123456789abcdef0123\n"}
	for _, k := range ok {
		if !rawKeyPattern.MatchString(k) {
			t.Errorf("%q should be key-shaped", k)
		}
	}
	for _, k := range bad {
		if rawKeyPattern.MatchString(k) {
			t.Errorf("%q should not be key-shaped", k)
		}
	}
}
