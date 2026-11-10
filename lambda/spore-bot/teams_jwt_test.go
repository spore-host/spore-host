package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

const (
	teamsTestKid        = "k1"
	teamsTestAppID      = "bot-app-id"
	teamsTestServiceURL = "https://smba.trafficmanager.net/teams/"
	teamsTestChannel    = "msteams"
)

// mkJWT builds a signed RS256 JWT for testing. kid selects which key the
// verifier will look up; claims is marshaled as the payload.
func mkJWT(t *testing.T, key *rsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	hdr := map[string]any{"alg": "RS256", "typ": "JWT", "kid": kid}
	hb, _ := json.Marshal(hdr)
	cb, _ := json.Marshal(claims)
	seg := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString(cb)
	h := sha256.Sum256([]byte(seg))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, h[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return seg + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// withTestKey injects a public key, endorsed for msteams, into the JWKS cache
// under kid and marks it fresh, then restores the prior cache state on cleanup.
func withTestKey(t *testing.T, kid string, pub *rsa.PublicKey) {
	t.Helper()
	withTestKeySet(t, map[string]signingKey{kid: {pub: pub, endorsements: []string{teamsTestChannel}}})
}

// withTestKeySet replaces the JWKS cache with keys, marked fresh, until the
// test ends.
func withTestKeySet(t *testing.T, keys map[string]signingKey) {
	t.Helper()
	botFrameworkKeys.mu.Lock()
	prevKeys, prevAt := botFrameworkKeys.keys, botFrameworkKeys.fetchedAt
	botFrameworkKeys.keys = keys
	botFrameworkKeys.fetchedAt = time.Now()
	botFrameworkKeys.mu.Unlock()
	t.Cleanup(func() {
		botFrameworkKeys.mu.Lock()
		botFrameworkKeys.keys, botFrameworkKeys.fetchedAt = prevKeys, prevAt
		botFrameworkKeys.mu.Unlock()
	})
}

// botFrameworkClaims are the claims of a genuine Bot Framework token for
// appID, issued for an activity whose serviceUrl is serviceURL.
func botFrameworkClaims(appID, serviceURL string) map[string]any {
	return map[string]any{
		"iss":        botFrameworkIssuer,
		"aud":        appID,
		"serviceurl": serviceURL,
		"exp":        time.Now().Add(time.Hour).Unix(),
		"nbf":        time.Now().Add(-time.Minute).Unix(),
	}
}

func validClaims(appID string) map[string]any {
	return botFrameworkClaims(appID, teamsTestServiceURL)
}

// verify runs verifyTeamsJWT for the standard test activity.
func verify(tok string) error {
	return verifyTeamsJWT(context.Background(), "Bearer "+tok, teamsTestAppID, teamsTestServiceURL, teamsTestChannel)
}

func newTestKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func TestVerifyTeamsJWT_Valid(t *testing.T) {
	key := newTestKey(t)
	withTestKey(t, teamsTestKid, &key.PublicKey)
	if err := verify(mkJWT(t, key, teamsTestKid, validClaims(teamsTestAppID))); err != nil {
		t.Errorf("expected valid token to pass, got: %v", err)
	}
}

func TestVerifyTeamsJWT_NoAppID(t *testing.T) {
	if err := verifyTeamsJWT(context.Background(), "Bearer x", "", teamsTestServiceURL, teamsTestChannel); err == nil {
		t.Error("expected missing App ID to fail")
	}
}

// TestVerifyTeamsJWT_RejectsClaims: a correctly signed token is still
// rejected when any claim the verifier checks is wrong or missing.
func TestVerifyTeamsJWT_RejectsClaims(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"wrong audience", func(c map[string]any) { c["aud"] = "some-other-bot" }},
		{"no audience", func(c map[string]any) { delete(c, "aud") }},
		{"wrong issuer", func(c map[string]any) { c["iss"] = "https://evil.example.com" }},
		{"no issuer", func(c map[string]any) { delete(c, "iss") }},
		{"expired", func(c map[string]any) { c["exp"] = time.Now().Add(-time.Hour).Unix() }},
		{"no expiry", func(c map[string]any) { delete(c, "exp") }},
		{"not yet valid", func(c map[string]any) { c["nbf"] = time.Now().Add(time.Hour).Unix() }},
		// The reply to an activity goes to its serviceUrl with a Bot Framework
		// token, so a token issued for another serviceUrl must not vouch for it.
		{"wrong serviceurl", func(c map[string]any) { c["serviceurl"] = "https://attacker.example.com/" }},
		{"no serviceurl", func(c map[string]any) { delete(c, "serviceurl") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			key := newTestKey(t)
			withTestKey(t, teamsTestKid, &key.PublicKey)
			claims := validClaims(teamsTestAppID)
			tt.mutate(claims)
			if err := verify(mkJWT(t, key, teamsTestKid, claims)); err == nil {
				t.Errorf("expected token with %s to fail", tt.name)
			}
		})
	}
}

// TestVerifyTeamsJWT_ActivityMismatch: the token is valid, but the activity it
// arrives with names another serviceUrl or has none.
func TestVerifyTeamsJWT_ActivityMismatch(t *testing.T) {
	key := newTestKey(t)
	withTestKey(t, teamsTestKid, &key.PublicKey)
	tok := "Bearer " + mkJWT(t, key, teamsTestKid, validClaims(teamsTestAppID))
	for _, serviceURL := range []string{"https://attacker.example.com/", "", "https://smba.trafficmanager.net/teams"} {
		if err := verifyTeamsJWT(context.Background(), tok, teamsTestAppID, serviceURL, teamsTestChannel); err == nil {
			t.Errorf("expected activity serviceUrl %q to fail against the token's %q", serviceURL, teamsTestServiceURL)
		}
	}
}

// TestVerifyTeamsJWT_Endorsement: the signing key must be endorsed for the
// activity's channel.
func TestVerifyTeamsJWT_Endorsement(t *testing.T) {
	key := newTestKey(t)
	tok := "Bearer " + mkJWT(t, key, teamsTestKid, validClaims(teamsTestAppID))

	withTestKeySet(t, map[string]signingKey{teamsTestKid: {pub: &key.PublicKey, endorsements: []string{"skype"}}})
	if err := verifyTeamsJWT(context.Background(), tok, teamsTestAppID, teamsTestServiceURL, teamsTestChannel); err == nil {
		t.Error("expected a key not endorsed for msteams to fail")
	}
	withTestKeySet(t, map[string]signingKey{teamsTestKid: {pub: &key.PublicKey}})
	if err := verifyTeamsJWT(context.Background(), tok, teamsTestAppID, teamsTestServiceURL, teamsTestChannel); err == nil {
		t.Error("expected a key with no endorsements to fail")
	}
	withTestKey(t, teamsTestKid, &key.PublicKey)
	if err := verifyTeamsJWT(context.Background(), tok, teamsTestAppID, teamsTestServiceURL, ""); err == nil {
		t.Error("expected an activity with no channelId to fail")
	}
}

func TestVerifyTeamsJWT_WrongKey(t *testing.T) {
	signKey := newTestKey(t)
	otherKey := newTestKey(t)
	withTestKey(t, teamsTestKid, &otherKey.PublicKey) // cache holds a DIFFERENT key for k1
	if err := verify(mkJWT(t, signKey, teamsTestKid, validClaims(teamsTestAppID))); err == nil {
		t.Error("expected signature mismatch to fail")
	}
}

func TestVerifyTeamsJWT_AlgNone(t *testing.T) {
	// "alg":"none" with an empty signature must be rejected outright.
	hdr := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","kid":"k1"}`))
	cb, _ := json.Marshal(validClaims(teamsTestAppID))
	claims := base64.RawURLEncoding.EncodeToString(cb)
	if err := verify(hdr + "." + claims + "."); err == nil {
		t.Error("expected alg=none to fail")
	}
}

func TestVerifyTeamsJWT_Malformed(t *testing.T) {
	if err := verify("not-a-jwt"); err == nil {
		t.Error("expected malformed token to fail")
	}
}

func TestVerifyTeamsJWT_AudienceArray(t *testing.T) {
	key := newTestKey(t)
	withTestKey(t, teamsTestKid, &key.PublicKey)
	claims := validClaims(teamsTestAppID)
	claims["aud"] = []string{"other", teamsTestAppID}
	if err := verify(mkJWT(t, key, teamsTestKid, claims)); err != nil {
		t.Errorf("expected audience array containing App ID to pass, got: %v", err)
	}
}
