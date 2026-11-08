package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	substrate "github.com/scttfrdmn/substrate/emulator"
)

// Fixture credentials, worded so secret scanners do not flag them.
const (
	slackBotTokenFixture = "xoxb-slack-bot-token-fixture"
	teamsBotTokenFixture = "azure-bot-client-secret-fixture" // what `workspace add --platform teams --bot-token` stores
	bfTokenFixture       = "bot-framework-access-token-fixture"
)

// sentRequest is one outbound HTTP call the fan-out made.
type sentRequest struct {
	host, path, auth string
}

// platformRecorder stands in for Slack, the Bot Framework token endpoint and
// the Bot Framework conversation API, and records every call.
type platformRecorder struct {
	mu   sync.Mutex
	sent []sentRequest
}

func (p *platformRecorder) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Body != nil {
		_, _ = io.Copy(io.Discard, r.Body)
	}
	p.mu.Lock()
	p.sent = append(p.sent, sentRequest{host: r.URL.Host, path: r.URL.Path, auth: r.Header.Get("Authorization")})
	p.mu.Unlock()
	body := `{"ok":true}`
	if r.URL.Host == "login.microsoftonline.com" {
		b, _ := json.Marshal(map[string]any{"access_token": bfTokenFixture, "expires_in": 3600})
		body = string(b)
	}
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
}

// setupPlatformFixture holds a Slack workspace (T1) and a Teams tenant (TEN1),
// each with a bot token, and instance i-0abc registered for one Slack user and
// one Teams user, who has a stored conversation reference.
func setupPlatformFixture(t *testing.T, rec *platformRecorder) (aws.Config, *Registry) {
	t.Helper()
	ts := substrate.StartTestServer(t)
	awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithRegion("us-east-1"),
		awsconfig.WithBaseEndpoint(ts.URL),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("test", "test", "test")),
	)
	if err != nil {
		t.Fatalf("build AWS config: %v", err)
	}
	client := dynamodb.NewFromConfig(awsCfg)
	ctx := context.Background()
	if _, err := client.CreateTable(ctx, &dynamodb.CreateTableInput{
		TableName:   aws.String(testRegistryTable),
		BillingMode: dynamodbtypes.BillingModePayPerRequest,
		AttributeDefinitions: []dynamodbtypes.AttributeDefinition{
			{AttributeName: aws.String("user_key"), AttributeType: dynamodbtypes.ScalarAttributeTypeS},
			{AttributeName: aws.String("nickname"), AttributeType: dynamodbtypes.ScalarAttributeTypeS},
			{AttributeName: aws.String("instance_id"), AttributeType: dynamodbtypes.ScalarAttributeTypeS},
		},
		KeySchema: []dynamodbtypes.KeySchemaElement{
			{AttributeName: aws.String("user_key"), KeyType: dynamodbtypes.KeyTypeHash},
			{AttributeName: aws.String("nickname"), KeyType: dynamodbtypes.KeyTypeRange},
		},
		GlobalSecondaryIndexes: []dynamodbtypes.GlobalSecondaryIndex{{
			IndexName:  aws.String("instance_id-index"),
			KeySchema:  []dynamodbtypes.KeySchemaElement{{AttributeName: aws.String("instance_id"), KeyType: dynamodbtypes.KeyTypeHash}},
			Projection: &dynamodbtypes.Projection{ProjectionType: dynamodbtypes.ProjectionTypeAll},
		}},
	}); err != nil {
		t.Fatalf("create registry table: %v", err)
	}
	createWorkspacesTable(t, client)

	s := func(v string) dynamodbtypes.AttributeValue { return &dynamodbtypes.AttributeValueMemberS{Value: v} }
	put := func(table string, item map[string]dynamodbtypes.AttributeValue) {
		t.Helper()
		if _, err := client.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(table), Item: item}); err != nil {
			t.Fatalf("put %s: %v", table, err)
		}
	}
	put(testWorkspacesTable, map[string]dynamodbtypes.AttributeValue{
		"workspace_key": s("slack#T1"), "platform": s("slack"), "bot_token": s(slackBotTokenFixture),
	})
	put(testWorkspacesTable, map[string]dynamodbtypes.AttributeValue{
		"workspace_key": s("teams#TEN1"), "platform": s("teams"), "bot_token": s(teamsBotTokenFixture),
	})
	put(testRegistryTable, map[string]dynamodbtypes.AttributeValue{
		"user_key": s("slack#T1#U1"), "nickname": s("gpu1"), "instance_id": s("i-0abc"),
	})
	put(testRegistryTable, map[string]dynamodbtypes.AttributeValue{
		"user_key": s("teams#TEN1#29:teams-user"), "nickname": s("gpu1"), "instance_id": s("i-0abc"),
	})
	put(testRegistryTable, map[string]dynamodbtypes.AttributeValue{
		"user_key": s("teams#TEN1#29:teams-user"), "nickname": s("teams_ref"),
		"service_url": s("https://smba.example.invalid/teams/"), "conversation_id": s("a:conv-1"),
	})

	origHTTP, origCfg := httpClient, cfg
	teamsBFTokenMu.Lock()
	origTok, origExp := teamsBFToken, teamsBFTokenExp
	teamsBFToken = "" // no cached Bot Framework token from another test
	teamsBFTokenMu.Unlock()
	t.Cleanup(func() {
		httpClient, cfg = origHTTP, origCfg
		teamsBFTokenMu.Lock()
		teamsBFToken, teamsBFTokenExp = origTok, origExp
		teamsBFTokenMu.Unlock()
	})
	httpClient = &http.Client{Transport: rec}
	cfg = awsCfg // sendTeamsDMs reads the package config
	t.Setenv("TEAMS_APP_ID", "teams-app-id-fixture")
	t.Setenv("TEAMS_APP_SECRET", "teams-app-secret-fixture")
	t.Setenv("TEAMS_TENANT_ID", "")
	t.Setenv("TWILIO_NUMBER_SPORE", "") // SMS is not what this test is about

	return awsCfg, &Registry{client: client, registryTable: testRegistryTable, workspacesTable: testWorkspacesTable}
}

// TestHandleNotifyDispatchesDMsPerPlatform is #596: a Teams notification
// (an instance launched with --notify-platform teams) must reach its Teams
// users, and no notification may call Slack's API with a Teams credential.
func TestHandleNotifyDispatchesDMsPerPlatform(t *testing.T) {
	cases := []struct {
		platform, workspace string
		wantSlackDM         bool // chat.postMessage, with the Slack bot token
		wantTeamsDM         bool // Bot Framework conversation activity
	}{
		{platform: "slack", workspace: "T1", wantSlackDM: true, wantTeamsDM: true},
		{platform: "", workspace: "T1"}, // no "#T1" workspace or registration: nothing to DM
		{platform: "teams", workspace: "TEN1", wantTeamsDM: true},
	}
	for _, tc := range cases {
		t.Run("platform="+tc.platform, func(t *testing.T) {
			rec := &platformRecorder{}
			awsCfg, r := setupPlatformFixture(t, rec)
			body, _ := json.Marshal(NotifyRequest{Platform: tc.platform, WorkspaceID: tc.workspace,
				EventType: "ttl_warning", InstanceName: "gpu1", InstanceID: "i-0abc", Detail: "5m"})
			resp, err := handleNotify(context.Background(), awsCfg, r,
				events.APIGatewayProxyRequest{HTTPMethod: "POST", Path: "/notify", Body: string(body)})
			if err != nil || resp.StatusCode != 200 {
				t.Fatalf("handleNotify = %d, %v", resp.StatusCode, err)
			}

			var slackDMs, teamsDMs int
			for _, c := range rec.sent {
				if strings.Contains(c.auth, teamsBotTokenFixture) {
					t.Errorf("%s%s was called with the Teams tenant's bot token", c.host, c.path)
				}
				switch {
				case c.host == "slack.com":
					if c.path != "/api/chat.postMessage" || c.auth != "Bearer "+slackBotTokenFixture {
						t.Errorf("Slack call %s with %q; want chat.postMessage with the Slack bot token", c.path, c.auth)
					}
					slackDMs++
				case c.host == "smba.example.invalid":
					if c.path != "/teams/v3/conversations/a:conv-1/activities" || c.auth != "Bearer "+bfTokenFixture {
						t.Errorf("Teams call %s with %q; want the conversation activity with the Bot Framework token", c.path, c.auth)
					}
					teamsDMs++
				}
			}
			if got := slackDMs > 0; got != tc.wantSlackDM {
				t.Errorf("Slack DMs sent = %d, want any: %v (calls: %v)", slackDMs, tc.wantSlackDM, rec.sent)
			}
			if slackDMs > 1 {
				t.Errorf("Slack DMs sent = %d, want 1: a Teams user must not be DMed through Slack (calls: %v)", slackDMs, rec.sent)
			}
			if got := teamsDMs > 0; got != tc.wantTeamsDM {
				t.Errorf("Teams DMs sent = %d, want any: %v (calls: %v)", teamsDMs, tc.wantTeamsDM, rec.sent)
			}
		})
	}
}

// TestDMSendersFor pins the dispatch table, including the platforms with no
// per-user DM.
func TestDMSendersFor(t *testing.T) {
	for platform, want := range map[string]dmSenders{
		"slack":   {slack: true, teams: true},
		"":        {slack: true, teams: true},
		"teams":   {teams: true},
		"discord": {},
		"sms":     {},
	} {
		if got := dmSendersFor(platform); got != want {
			t.Errorf("dmSendersFor(%q) = %+v, want %+v", platform, got, want)
		}
	}
}
