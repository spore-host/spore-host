package main

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	substrate "github.com/scttfrdmn/substrate/emulator"
)

// Tests for #572: nothing a spore-bot handler starts may still be running when
// it returns, because Lambda freezes the environment then. Like #566's, they
// slow the backends down, so work left in a goroutine is still unfinished at
// return and shows up as missing.

// slowTransport delays each request by delay (or until its context ends), then
// passes it on. Put in front of DynamoDB, it makes a write left running in a
// goroutine still be in flight when the caller checks for it.
type slowTransport struct {
	delay time.Duration
	next  http.RoundTripper
}

func (s slowTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	select {
	case <-time.After(s.delay):
	case <-r.Context().Done():
		return nil, r.Context().Err()
	}
	return s.next.RoundTrip(r)
}

// lifetimeFixture is a DynamoDB emulator with the registry, workspaces and
// audit tables. reg and auditor talk to it through a slowTransport; ddb is a
// direct client for checking what was written.
type lifetimeFixture struct {
	ddb  *dynamodb.Client
	reg  *Registry
	cfg  aws.Config
	chat *deliveryRecorder // every outbound chat call (Slack, Teams, Discord)

	slackSecret, teamsSecret string
	discordKey               ed25519.PrivateKey
}

func setupLifetimeFixture(t *testing.T, ddbDelay time.Duration) *lifetimeFixture {
	t.Helper()
	ts := substrate.StartTestServer(t)
	load := func(opts ...func(*awsconfig.LoadOptions) error) aws.Config {
		t.Helper()
		base := []func(*awsconfig.LoadOptions) error{
			awsconfig.WithRegion("us-east-1"),
			awsconfig.WithBaseEndpoint(ts.URL),
			awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("test", "test", "test")),
		}
		c, err := awsconfig.LoadDefaultConfig(context.Background(), append(base, opts...)...)
		if err != nil {
			t.Fatalf("build AWS config: %v", err)
		}
		return c
	}
	plain := load()
	slow := load(awsconfig.WithHTTPClient(&http.Client{Transport: slowTransport{ddbDelay, http.DefaultTransport}}))

	f := &lifetimeFixture{
		ddb:         dynamodb.NewFromConfig(plain),
		cfg:         slow,
		chat:        &deliveryRecorder{delay: 10 * time.Millisecond},
		slackSecret: "slack-signing-secret",
		teamsSecret: "teams-shared-secret",
	}
	createRegistryTable(t, f.ddb)
	createWorkspacesTable(t, f.ddb)
	createAuditTable(t, f.ddb)
	slowDDB := dynamodb.NewFromConfig(slow)
	f.reg = &Registry{client: slowDDB, registryTable: testRegistryTable, workspacesTable: testWorkspacesTable}

	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	f.discordKey = priv

	s := func(v string) dynamodbtypes.AttributeValue { return &dynamodbtypes.AttributeValueMemberS{Value: v} }
	for _, ws := range []map[string]dynamodbtypes.AttributeValue{
		{"workspace_key": s("slack#T1"), "platform": s("slack"), "signing_secret": s(f.slackSecret), "bot_token": s("xoxb-test")},
		{"workspace_key": s("teams#tenant1"), "platform": s("teams"), "signing_secret": s(f.teamsSecret)},
		{"workspace_key": s("discord#g1"), "platform": s("discord")},
	} {
		if _, err := f.ddb.PutItem(context.Background(), &dynamodb.PutItemInput{TableName: aws.String(testWorkspacesTable), Item: ws}); err != nil {
			t.Fatalf("put workspace: %v", err)
		}
	}

	// Package state the handlers read. functionName empty makes invokeAsync
	// fail, as it would if the Lambda API refused the self-invocation.
	origAuditor, origFn, origHTTP, origCfg, origDiscord := auditor, functionName, httpClient, cfg, discordPublicKey
	t.Cleanup(func() {
		auditor, functionName, httpClient, cfg, discordPublicKey = origAuditor, origFn, origHTTP, origCfg, origDiscord
	})
	auditor = &Auditor{client: slowDDB, tableName: testAuditTable}
	functionName = ""
	httpClient = &http.Client{Transport: f.chat}
	cfg = slow
	discordPublicKey = hex.EncodeToString(pub)
	return f
}

func (f *lifetimeFixture) slackRequest(text string) events.APIGatewayProxyRequest {
	body := url.Values{
		"command": {"/spore"}, "text": {text}, "user_id": {"U1"}, "team_id": {"T1"},
		"channel_id": {"C1"}, "response_url": {"https://hooks.slack.com/commands/T1/1/x"},
	}.Encode()
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	return events.APIGatewayProxyRequest{HTTPMethod: "POST", Path: "/slack", Body: body, Headers: map[string]string{
		"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": makeSlackSig(f.slackSecret, ts, body),
	}}
}

func (f *lifetimeFixture) teamsRequest(text string) events.APIGatewayProxyRequest {
	body := `{"type":"message","text":"<at>spore</at> ` + text + `","from":{"id":"user1"},` +
		`"recipient":{"id":"bot1"},"conversation":{"id":"conv1"},"serviceUrl":"https://smba.trafficmanager.net/teams/",` +
		`"channelData":{"tenant":{"id":"tenant1"}}}`
	mac := hmac.New(sha256.New, []byte(f.teamsSecret))
	mac.Write([]byte(body))
	return events.APIGatewayProxyRequest{HTTPMethod: "POST", Path: "/teams", Body: body, Headers: map[string]string{
		"Authorization": "HMAC " + encodeBase64(mac.Sum(nil)),
	}}
}

func (f *lifetimeFixture) discordRequest(command string) events.APIGatewayProxyRequest {
	body := `{"type":2,"guild_id":"g1","application_id":"app1","token":"tok1","member":{"user":{"id":"u1"}},` +
		`"data":{"name":"spore","options":[{"name":"command","value":"` + command + `"}]}}`
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := ed25519.Sign(f.discordKey, append([]byte(ts), body...))
	return events.APIGatewayProxyRequest{HTTPMethod: "POST", Path: "/discord", Body: body, Headers: map[string]string{
		"X-Signature-Ed25519": hex.EncodeToString(sig), "X-Signature-Timestamp": ts,
	}}
}

// auditRecords returns every audit record, read directly (not through the
// slow transport).
func (f *lifetimeFixture) auditRecords(t *testing.T) []map[string]dynamodbtypes.AttributeValue {
	t.Helper()
	out, err := f.ddb.Scan(context.Background(), &dynamodb.ScanInput{TableName: aws.String(testAuditTable)})
	if err != nil {
		t.Fatalf("scan audit table: %v", err)
	}
	return out.Items
}

func attrS(item map[string]dynamodbtypes.AttributeValue, k string) string {
	if v, ok := item[k].(*dynamodbtypes.AttributeValueMemberS); ok {
		return v.Value
	}
	return ""
}

// invocationCtx stands in for a Lambda invocation's context.
func invocationCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// TestAuditLogWritesBeforeReturning: the audit record is in DynamoDB when Log
// returns. It used to be written by a goroutine that Lambda froze with the
// handler (#572).
func TestAuditLogWritesBeforeReturning(t *testing.T) {
	f := setupLifetimeFixture(t, 150*time.Millisecond)
	auditor.Log(invocationCtx(t), AuditEvent{AuditID: "a-572", Command: "stop", Result: AuditResultSuccess})

	got := f.auditRecords(t)
	if len(got) != 1 || attrS(got[0], "audit_id") != "a-572" {
		t.Fatalf("when Log returned the audit table held %v, want the a-572 record", got)
	}
}

// TestAuditLogBoundedUnderLambdaDeadline: a hung audit write cannot hold the
// handler past its deadline; Log gives up lambdaDeadlineMargin (2s) before it.
func TestAuditLogBoundedUnderLambdaDeadline(t *testing.T) {
	setupLifetimeFixture(t, time.Hour) // every DynamoDB call hangs

	const left = 2500 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), left)
	defer cancel()
	start := time.Now()
	auditor.Log(ctx, AuditEvent{Command: "stop", Result: AuditResultSuccess})
	if elapsed := time.Since(start); elapsed >= left-time.Second {
		t.Errorf("Log took %v with %v left; it should stop ~2s before the deadline", elapsed, left)
	}
}

// TestWebhookNotQueued covers the old fallback: when Phase 2 cannot be queued
// (the async self-invocation fails), the command used to run in a goroutine
// that outlived the handler, while the user was shown "Stopping..." (#572).
// Now the user is told it did not run, the failure is audited before the
// handler returns, and nothing is left running.
func TestWebhookNotQueued(t *testing.T) {
	tests := []struct {
		platform string
		req      func(*lifetimeFixture) events.APIGatewayProxyRequest
		command  string
	}{
		{"slack", func(f *lifetimeFixture) events.APIGatewayProxyRequest { return f.slackRequest("help") }, "help"},
		{"slack", func(f *lifetimeFixture) events.APIGatewayProxyRequest { return f.slackRequest("list") }, "list"},
		// Teams "list" used to run in a goroutine even when the queue worked.
		{"teams", func(f *lifetimeFixture) events.APIGatewayProxyRequest { return f.teamsRequest("list") }, "list"},
		{"teams", func(f *lifetimeFixture) events.APIGatewayProxyRequest { return f.teamsRequest("status gpu1") }, "status"},
		{"discord", func(f *lifetimeFixture) events.APIGatewayProxyRequest { return f.discordRequest("help") }, "help"},
	}
	for _, tt := range tests {
		t.Run(tt.platform+"/"+tt.command, func(t *testing.T) {
			f := setupLifetimeFixture(t, 100*time.Millisecond)

			resp, err := handleWebhook(invocationCtx(t), f.cfg, f.reg, tt.req(f))
			audits := f.auditRecords(t) // as of the moment the handler returned
			if err != nil || resp.StatusCode != 200 {
				t.Fatalf("handleWebhook = %d %s, %v", resp.StatusCode, resp.Body, err)
			}
			if !strings.Contains(resp.Body, "did not run") {
				t.Errorf("reply %s does not tell the user the command did not run", resp.Body)
			}
			if tt.platform == "discord" && !strings.Contains(resp.Body, `"type":4`) {
				t.Errorf("Discord reply %s is not an immediate message (type 4); a deferred ack promises a follow-up that will not come", resp.Body)
			}

			if len(audits) != 1 || attrS(audits[0], "result") != AuditResultError || attrS(audits[0], "command") != tt.command {
				var got []string
				for _, a := range audits {
					got = append(got, attrS(a, "command")+"="+attrS(a, "result"))
				}
				t.Errorf("at return, audit records = %v; want one %q record for %q", got, AuditResultError, tt.command)
			}

			if tt.platform == "teams" {
				ref, err := f.ddb.GetItem(context.Background(), &dynamodb.GetItemInput{
					TableName: aws.String(testRegistryTable),
					Key: map[string]dynamodbtypes.AttributeValue{
						"user_key": &dynamodbtypes.AttributeValueMemberS{Value: "teams#tenant1#user1"},
						"nickname": &dynamodbtypes.AttributeValueMemberS{Value: "teams_ref"},
					},
				})
				if err != nil || ref.Item == nil || attrS(ref.Item, "conversation_id") != "conv1" {
					t.Errorf("at return, Teams conversation reference = %v, %v; want it stored", ref, err)
				}
			}

			// Nothing may still be running: a straggler would post to the chat
			// platform or write another audit record here.
			time.Sleep(500 * time.Millisecond)
			if done, _ := f.chat.snapshot(); len(done) != 0 {
				t.Errorf("chat calls made after handleWebhook returned: %v", done)
			}
			if after := f.auditRecords(t); len(after) != len(audits) {
				t.Errorf("%d audit records written after handleWebhook returned", len(after)-len(audits))
			}
		})
	}
}

// TestTeamsWebhookStoresConversationRefBeforeReturning: the Teams conversation
// reference, which proactive DMs need, is stored before the handler returns
// (#572), on a command that is queued normally.
func TestTeamsWebhookStoresConversationRefBeforeReturning(t *testing.T) {
	f := setupLifetimeFixture(t, 150*time.Millisecond)
	sc, err := handleTeamsWebhook(invocationCtx(t), f.reg, f.teamsRequest("help"))
	if err != nil || sc == nil {
		t.Fatalf("handleTeamsWebhook = %v, %v", sc, err)
	}
	ref, err := f.ddb.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName: aws.String(testRegistryTable),
		Key: map[string]dynamodbtypes.AttributeValue{
			"user_key": &dynamodbtypes.AttributeValueMemberS{Value: "teams#tenant1#user1"},
			"nickname": &dynamodbtypes.AttributeValueMemberS{Value: "teams_ref"},
		},
	})
	if err != nil || ref.Item == nil {
		t.Fatalf("at return, no Teams conversation reference: %v", err)
	}
	if got := attrS(ref.Item, "service_url"); got != "https://smba.trafficmanager.net/teams/" {
		t.Errorf("service_url = %q", got)
	}
}
