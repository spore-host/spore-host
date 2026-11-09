package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Teams requests are authenticated only with Bot Framework tokens. These
// tests drive the whole webhook (handleWebhook) against the DynamoDB emulator.

// teamsActivityBody is a Teams activity for tenant1/user1 whose replies go to
// serviceURL.
func teamsActivityBody(text, serviceURL string) string {
	return `{"type":"message","channelId":"msteams","text":"` + text + `","from":{"id":"user1"},` +
		`"recipient":{"id":"bot1"},"conversation":{"id":"conv1"},"serviceUrl":"` + serviceURL + `",` +
		`"channelData":{"tenant":{"id":"tenant1"}}}`
}

// putRawTeamsWorkspace stores teams#tenant1 with signing_secret as it would
// have been written by spawn's `notify workspace add --signing-secret`, which
// does not go through spore-bot.
func (f *lifetimeFixture) putRawTeamsWorkspace(t *testing.T, signingSecret string) {
	t.Helper()
	s := func(v string) dynamodbtypes.AttributeValue { return &dynamodbtypes.AttributeValueMemberS{Value: v} }
	if _, err := f.ddb.PutItem(context.Background(), &dynamodb.PutItemInput{
		TableName: aws.String(testWorkspacesTable),
		Item: map[string]dynamodbtypes.AttributeValue{
			"workspace_key": s("teams#tenant1"), "platform": s("teams"),
			"bot_token": s("azure-bot-secret"), "signing_secret": s(signingSecret),
		},
	}); err != nil {
		t.Fatalf("put workspace: %v", err)
	}
}

// conversationRef returns user1's stored Teams conversation reference, or nil.
func (f *lifetimeFixture) conversationRef(t *testing.T) map[string]dynamodbtypes.AttributeValue {
	t.Helper()
	out, err := f.ddb.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName: aws.String(testRegistryTable),
		Key: map[string]dynamodbtypes.AttributeValue{
			"user_key": &dynamodbtypes.AttributeValueMemberS{Value: "teams#tenant1#user1"},
			"nickname": &dynamodbtypes.AttributeValueMemberS{Value: "teams_ref"},
		},
	})
	if err != nil {
		t.Fatalf("get conversation ref: %v", err)
	}
	return out.Item
}

// assertTeamsRejected runs req through handleWebhook and checks it was refused
// (401) with nothing done: no command queued or audited, no conversation
// reference stored, no outbound call.
func assertTeamsRejected(t *testing.T, f *lifetimeFixture, req events.APIGatewayProxyRequest) {
	t.Helper()
	resp, err := handleWebhook(invocationCtx(t), f.cfg, f.reg, req)
	if err != nil {
		t.Fatalf("handleWebhook error: %v", err)
	}
	if resp.StatusCode != 401 {
		t.Errorf("status = %d (%s), want 401", resp.StatusCode, resp.Body)
	}
	if ref := f.conversationRef(t); ref != nil {
		t.Errorf("a rejected request stored a conversation reference: %v", ref)
	}
	if audits := f.auditRecords(t); len(audits) != 0 {
		t.Errorf("a rejected request reached dispatch: %d audit records", len(audits))
	}
	if done, _ := f.chat.snapshot(); len(done) != 0 {
		t.Errorf("a rejected request made outbound calls: %v", done)
	}
}

// TestTeamsWebhook_ForgedHMACWithAppIDRejected: the advisory case. A Teams
// workspace stored with the bot's (public) App ID as its signing_secret, and a
// request signed with that App ID as the HMAC key, is rejected. So is a
// request correctly signed with a genuine (base64) outgoing-webhook secret:
// the HMAC scheme is not accepted at all.
func TestTeamsWebhook_ForgedHMACWithAppIDRejected(t *testing.T) {
	genuine := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
	genuineKey, _ := base64.StdEncoding.DecodeString(genuine)
	for _, tt := range []struct {
		name   string
		stored string
		key    []byte
	}{
		{"App ID as HMAC key", teamsTestAppID, []byte(teamsTestAppID)},
		{"genuine outgoing-webhook secret", genuine, genuineKey},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := setupLifetimeFixture(t, 0)
			f.putRawTeamsWorkspace(t, tt.stored)
			body := teamsActivityBody("/spore stop gpu1", "https://attacker.example.com/")
			mac := hmac.New(sha256.New, tt.key)
			mac.Write([]byte(body))
			assertTeamsRejected(t, f, events.APIGatewayProxyRequest{
				HTTPMethod: "POST", Path: "/teams", Body: body,
				Headers: map[string]string{"Authorization": "HMAC " + base64.StdEncoding.EncodeToString(mac.Sum(nil))},
			})
		})
	}
}

// TestTeamsWebhook_NonBearerRejected: any request without a Bot Framework
// bearer token is refused, whatever it carries instead.
func TestTeamsWebhook_NonBearerRejected(t *testing.T) {
	f := setupLifetimeFixture(t, 0)
	f.putRawTeamsWorkspace(t, "some-signing-secret")
	body := teamsActivityBody("/spore list", teamsTestServiceURL)
	valid := mkJWT(t, f.teamsKey, teamsTestKid, botFrameworkClaims(teamsTestAppID, teamsTestServiceURL))
	for name, headers := range map[string]map[string]string{
		"no Authorization": {},
		"empty":            {"Authorization": ""},
		"HMAC":             {"Authorization": "HMAC AAAA"},
		"Basic":            {"Authorization": "Basic dXNlcjpwYXNz"},
		"bare token":       {"Authorization": valid},
		"lowercase bearer": {"Authorization": "bearer " + valid},
		"empty bearer":     {"Authorization": "Bearer "},
	} {
		t.Run(name, func(t *testing.T) {
			assertTeamsRejected(t, f, events.APIGatewayProxyRequest{HTTPMethod: "POST", Path: "/teams", Body: body, Headers: headers})
		})
	}
}

// TestTeamsWebhook_BadBearerRejected: a correctly signed Bot Framework token
// is refused when its audience or issuer is wrong, or when it was issued for
// another serviceUrl than the one the activity tells spore-bot to reply to.
func TestTeamsWebhook_BadBearerRejected(t *testing.T) {
	tests := []struct {
		name        string
		claims      map[string]any
		bodyService string
	}{
		{"wrong audience", botFrameworkClaims("some-other-bot", teamsTestServiceURL), teamsTestServiceURL},
		{"wrong issuer", func() map[string]any {
			c := botFrameworkClaims(teamsTestAppID, teamsTestServiceURL)
			c["iss"] = "https://login.microsoftonline.com/tenant/v2.0"
			return c
		}(), teamsTestServiceURL},
		// A genuine token, with the activity body rewritten to send the reply
		// (and its Bot Framework token) somewhere else.
		{"serviceUrl swapped in body", botFrameworkClaims(teamsTestAppID, teamsTestServiceURL), "https://attacker.example.com/"},
		{"token for another serviceUrl", botFrameworkClaims(teamsTestAppID, "https://attacker.example.com/"), teamsTestServiceURL},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := setupLifetimeFixture(t, 0)
			tok := mkJWT(t, f.teamsKey, teamsTestKid, tt.claims)
			assertTeamsRejected(t, f, events.APIGatewayProxyRequest{
				HTTPMethod: "POST", Path: "/teams", Body: teamsActivityBody("/spore list", tt.bodyService),
				Headers: map[string]string{"Authorization": "Bearer " + tok},
			})
		})
	}
}

// TestTeamsWebhook_ValidBearerAccepted: a valid token, verified against the
// injected key set, is accepted, and the conversation reference it stores
// points at the serviceUrl the token vouched for. A signing_secret on the
// workspace plays no part.
func TestTeamsWebhook_ValidBearerAccepted(t *testing.T) {
	f := setupLifetimeFixture(t, 0)
	f.putRawTeamsWorkspace(t, teamsTestAppID)
	tok := mkJWT(t, f.teamsKey, teamsTestKid, botFrameworkClaims(teamsTestAppID, teamsTestServiceURL))
	resp, err := handleWebhook(invocationCtx(t), f.cfg, f.reg, events.APIGatewayProxyRequest{
		HTTPMethod: "POST", Path: "/teams", Body: teamsActivityBody("/spore help", teamsTestServiceURL),
		Headers: map[string]string{"authorization": "Bearer " + tok}, // header name case varies
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("handleWebhook = %d %s, %v; want 200", resp.StatusCode, resp.Body, err)
	}
	if !strings.Contains(resp.Body, `"type":"message"`) {
		t.Errorf("reply %s is not a Teams message", resp.Body)
	}
	ref := f.conversationRef(t)
	if got := attrS(ref, "service_url"); got != teamsTestServiceURL {
		t.Errorf("stored service_url = %q, want %q", got, teamsTestServiceURL)
	}
}

// TestFetchJWKS_Endorsements: endorsements are read from Microsoft's key set,
// so the endorsement check sees real values.
func TestFetchJWKS_Endorsements(t *testing.T) {
	key := newTestKey(t)
	n := base64.RawURLEncoding.EncodeToString(key.N.Bytes())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{
			{"kty": "RSA", "kid": "k1", "n": n, "e": "AQAB", "endorsements": []string{"msteams", "skype"}},
		}})
	}))
	defer srv.Close()
	origHTTP := httpClient
	httpClient = srv.Client()
	t.Cleanup(func() { httpClient = origHTTP })

	keys, err := fetchJWKS(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("fetchJWKS: %v", err)
	}
	k, ok := keys["k1"]
	if !ok || !k.endorses("msteams") || k.endorses("webchat") {
		t.Errorf("key k1 = %+v, %v; want endorsed for msteams only of the two", k, ok)
	}
}

// TestPostTeamsProactive_RefusesNonHTTPS: a reply, which carries a Bot
// Framework token, is never sent to a non-https service URL, and there is no
// unauthenticated fallback post without a conversation.
func TestPostTeamsProactive_RefusesNonHTTPS(t *testing.T) {
	rec := &deliveryRecorder{}
	origHTTP := httpClient
	httpClient = &http.Client{Transport: rec}
	t.Cleanup(func() { httpClient = origHTTP })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, u := range []string{"http://smba.trafficmanager.net/teams/", "ftp://x/", "", "smba.trafficmanager.net"} {
		if err := postTeamsProactive(ctx, u, "conv1", "hi"); err == nil {
			t.Errorf("postTeamsProactive(%q) succeeded; want refused", u)
		}
	}
	if err := postTeamsResponse(teamsTestServiceURL, "hi"); err == nil {
		t.Error("postTeamsResponse with no conversation ID succeeded; want refused")
	}
	if done, _ := rec.snapshot(); len(done) != 0 {
		t.Errorf("outbound calls made: %v", done)
	}
}

// TestTeamsSigningSecretRefused: spore-bot never stores a Teams signing
// secret, through the admin API or any other writer.
func TestTeamsSigningSecretRefused(t *testing.T) {
	reg := &Registry{} // both refusals happen before any AWS call
	resp, err := adminWorkspaceAdd(context.Background(), reg, adminRequest{
		Platform: "teams", WorkspaceID: "tenant1", BotToken: "azure-bot-secret", SigningSecret: teamsTestAppID,
	}, "arn:aws:iam::123456789012:user/admin")
	if err != nil || resp.StatusCode != 400 || !strings.Contains(resp.Body, "signing_secret") {
		t.Errorf("adminWorkspaceAdd(teams, signing_secret) = %d %s, %v; want 400", resp.StatusCode, resp.Body, err)
	}
	err = reg.PutWorkspace(context.Background(), &WorkspaceConfig{
		WorkspaceKey: "teams#tenant1", Platform: "teams", BotToken: "azure-bot-secret", SigningSecret: teamsTestAppID,
	})
	if !errors.Is(err, errTeamsSigningSecret) {
		t.Errorf("PutWorkspace(teams, signing secret) = %v; want errTeamsSigningSecret", err)
	}
}
