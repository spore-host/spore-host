package main

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Bot Framework token validation (spore-host#372).
//
// Teams "Bearer <jwt>" requests arrive at a public Function URL. The token is
// issued by Microsoft's Bot Framework for our bot; without verifying it, any
// caller can send "Authorization: Bearer anything" plus a forged activity and
// drive an executable command. It is the only way a Teams request is
// authenticated. We verify the standard Bot Framework claims:
//
//   - signature:   RS256 against Microsoft's published JWKS (keyed by `kid`)
//   - issuer:      https://api.botframework.com
//   - audience:    equals our configured bot App ID (TEAMS_APP_ID)
//   - expiry/nbf:  token currently valid; exp is required
//   - serviceurl:  equals the activity's serviceUrl. spore-bot replies to that
//     URL with a Bot Framework token of its own, so it must be one Microsoft
//     vouched for, not one the request body picked.
//   - endorsement: the signing key is endorsed for the activity's channelId
//
// Docs: https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
const (
	botFrameworkIssuer    = "https://api.botframework.com"
	botFrameworkOpenIDURL = "https://login.botframework.com/v1/.well-known/openidconfiguration"
)

// signingKey is one Bot Framework signing key and the channels it is
// endorsed for.
type signingKey struct {
	pub          *rsa.PublicKey
	endorsements []string
}

// endorses reports whether the key is endorsed for channelID.
func (k signingKey) endorses(channelID string) bool {
	for _, e := range k.endorsements {
		if e == channelID {
			return true
		}
	}
	return false
}

// jwksCache caches the Bot Framework signing keys (modulus/exponent per kid).
// Microsoft rotates these infrequently; we refresh on a cache miss or TTL expiry.
type jwksCache struct {
	mu        sync.RWMutex
	keys      map[string]signingKey
	fetchedAt time.Time
}

var botFrameworkKeys = &jwksCache{keys: map[string]signingKey{}}

// jwksTTL bounds how long signing keys are cached before a forced refresh.
const jwksTTL = 24 * time.Hour

// verifyTeamsJWT validates a Bot Framework bearer token and returns nil if the
// token is authentic, issued for our bot, currently valid, and issued for this
// activity's serviceUrl and channel. appID is the configured bot App ID
// (TEAMS_APP_ID); serviceURL and channelID are the activity's serviceUrl and
// channelId. All three must be non-empty.
func verifyTeamsJWT(ctx context.Context, token, appID, serviceURL, channelID string) error {
	if appID == "" {
		return fmt.Errorf("TEAMS_APP_ID not configured")
	}
	if serviceURL == "" {
		return fmt.Errorf("activity has no serviceUrl")
	}
	if channelID == "" {
		return fmt.Errorf("activity has no channelId")
	}
	token = strings.TrimSpace(strings.TrimPrefix(token, "Bearer "))
	if token == "" {
		return fmt.Errorf("empty bearer token")
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return fmt.Errorf("malformed JWT")
	}

	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return fmt.Errorf("decode JWT header: %w", err)
	}
	var hdr struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(headerJSON, &hdr); err != nil {
		return fmt.Errorf("parse JWT header: %w", err)
	}
	// Only RS256 is accepted. Rejecting everything else closes the "alg":"none"
	// and HMAC-confusion classes of attack.
	if hdr.Alg != "RS256" {
		return fmt.Errorf("unexpected JWT alg %q (want RS256)", hdr.Alg)
	}

	claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return fmt.Errorf("decode JWT claims: %w", err)
	}
	var claims struct {
		Iss        string          `json:"iss"`
		Aud        json.RawMessage `json:"aud"`
		Exp        int64           `json:"exp"`
		Nbf        int64           `json:"nbf"`
		ServiceURL string          `json:"serviceurl"`
	}
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		return fmt.Errorf("parse JWT claims: %w", err)
	}

	if claims.Iss != botFrameworkIssuer {
		return fmt.Errorf("unexpected issuer %q", claims.Iss)
	}
	if !audienceMatches(claims.Aud, appID) {
		return fmt.Errorf("audience does not match configured bot App ID")
	}
	if claims.ServiceURL == "" || claims.ServiceURL != serviceURL {
		return fmt.Errorf("token serviceurl claim does not match the activity's serviceUrl")
	}
	now := time.Now().Unix()
	if claims.Exp == 0 {
		return fmt.Errorf("token has no expiry")
	}
	if now > claims.Exp {
		return fmt.Errorf("token expired")
	}
	// Allow 5 minutes of clock skew for nbf.
	if claims.Nbf != 0 && now+300 < claims.Nbf {
		return fmt.Errorf("token not yet valid")
	}

	key, err := botFrameworkKeys.keyFor(ctx, hdr.Kid)
	if err != nil {
		return fmt.Errorf("resolve signing key: %w", err)
	}
	if !key.endorses(channelID) {
		return fmt.Errorf("signing key is not endorsed for channel %q", channelID)
	}

	signed := []byte(parts[0] + "." + parts[1])
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return fmt.Errorf("decode JWT signature: %w", err)
	}
	hashed := sha256.Sum256(signed)
	if err := rsa.VerifyPKCS1v15(key.pub, crypto.SHA256, hashed[:], sig); err != nil {
		return fmt.Errorf("JWT signature invalid: %w", err)
	}
	return nil
}

// audienceMatches reports whether the JWT "aud" claim (string or []string)
// contains the expected App ID.
func audienceMatches(raw json.RawMessage, appID string) bool {
	if len(raw) == 0 {
		return false
	}
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return single == appID
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err == nil {
		for _, a := range list {
			if a == appID {
				return true
			}
		}
	}
	return false
}

// keyFor returns the signing key for the given kid, refreshing the JWKS from
// Microsoft on a cache miss or once the cached set is older than jwksTTL.
func (c *jwksCache) keyFor(ctx context.Context, kid string) (signingKey, error) {
	c.mu.RLock()
	key, ok := c.keys[kid]
	fresh := time.Since(c.fetchedAt) < jwksTTL
	c.mu.RUnlock()
	if ok && fresh {
		return key, nil
	}

	if err := c.refresh(ctx); err != nil {
		// On refresh failure, fall back to a stale cached key if we have one —
		// better to keep verifying with the last-known-good key than to fail open.
		if ok {
			return key, nil
		}
		return signingKey{}, err
	}

	c.mu.RLock()
	defer c.mu.RUnlock()
	if key, ok := c.keys[kid]; ok {
		return key, nil
	}
	return signingKey{}, fmt.Errorf("no signing key for kid %q", kid)
}

// refresh fetches the OpenID configuration, then the JWKS, and replaces the
// cached key set.
func (c *jwksCache) refresh(ctx context.Context) error {
	jwksURI, err := fetchJWKSURI(ctx, botFrameworkOpenIDURL)
	if err != nil {
		return err
	}
	keys, err := fetchJWKS(ctx, jwksURI)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.keys = keys
	c.fetchedAt = time.Now()
	c.mu.Unlock()
	return nil
}

func fetchJWKSURI(ctx context.Context, openIDURL string) (string, error) {
	body, err := httpGetJSON(ctx, openIDURL)
	if err != nil {
		return "", fmt.Errorf("fetch openid config: %w", err)
	}
	var doc struct {
		JWKSURI string `json:"jwks_uri"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return "", fmt.Errorf("parse openid config: %w", err)
	}
	if doc.JWKSURI == "" {
		return "", fmt.Errorf("openid config has no jwks_uri")
	}
	return doc.JWKSURI, nil
}

func fetchJWKS(ctx context.Context, jwksURI string) (map[string]signingKey, error) {
	body, err := httpGetJSON(ctx, jwksURI)
	if err != nil {
		return nil, fmt.Errorf("fetch jwks: %w", err)
	}
	var doc struct {
		Keys []struct {
			Kid          string   `json:"kid"`
			Kty          string   `json:"kty"`
			N            string   `json:"n"`
			E            string   `json:"e"`
			Endorsements []string `json:"endorsements"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("parse jwks: %w", err)
	}
	out := make(map[string]signingKey, len(doc.Keys))
	for _, k := range doc.Keys {
		if k.Kty != "RSA" || k.Kid == "" {
			continue
		}
		pub, err := rsaPublicKeyFromJWK(k.N, k.E)
		if err != nil {
			continue
		}
		out[k.Kid] = signingKey{pub: pub, endorsements: k.Endorsements}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("jwks contained no usable RSA keys")
	}
	return out, nil
}

// rsaPublicKeyFromJWK builds an RSA public key from the base64url-encoded
// modulus (n) and exponent (e) of a JWK.
func rsaPublicKeyFromJWK(nB64, eB64 string) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(nB64)
	if err != nil {
		return nil, fmt.Errorf("decode modulus: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(eB64)
	if err != nil {
		return nil, fmt.Errorf("decode exponent: %w", err)
	}
	// Left-pad the exponent to 8 bytes so it fits a uint64.
	if len(eBytes) > 8 {
		return nil, fmt.Errorf("exponent too large")
	}
	padded := make([]byte, 8)
	copy(padded[8-len(eBytes):], eBytes)
	e := binary.BigEndian.Uint64(padded)
	if e == 0 {
		return nil, fmt.Errorf("invalid zero exponent")
	}
	return &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: int(e),
	}, nil
}

// httpGetJSON performs a GET and returns the response body, using the shared
// httpClient with a short timeout context.
func httpGetJSON(ctx context.Context, url string) ([]byte, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MiB cap
}
