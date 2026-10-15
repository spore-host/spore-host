package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
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

// deliveryRecorder is an http.RoundTripper standing in for Slack and Twilio.
// Each call takes `delay` (or, with hang, blocks until its context ends) and
// is recorded as completed only once that is over, so a test can tell
// "finished before handleNotify returned" from "still running in a goroutine".
type deliveryRecorder struct {
	delay time.Duration
	hang  bool

	mu        sync.Mutex
	completed []string // host + path of each finished call
	ctxErrs   []error  // the request context's error when each call finished
}

func (d *deliveryRecorder) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Body != nil {
		_, _ = io.Copy(io.Discard, r.Body)
	}
	if d.hang {
		<-r.Context().Done()
	} else {
		select {
		case <-time.After(d.delay):
		case <-r.Context().Done():
		}
	}
	d.mu.Lock()
	d.completed = append(d.completed, r.URL.Host+r.URL.Path)
	d.ctxErrs = append(d.ctxErrs, r.Context().Err())
	d.mu.Unlock()
	if err := r.Context().Err(); err != nil {
		return nil, err
	}
	body := `{"ok":true}`
	if r.URL.Host == "api.twilio.com" {
		body = `{"sid":"test"}`
	}
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
}

func (d *deliveryRecorder) snapshot() ([]string, []error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.completed...), append([]error(nil), d.ctxErrs...)
}

// setupNotifyFixture starts a DynamoDB emulator holding a Slack workspace with
// a bot token, two users registered for instance i-0abc, and a phone number
// for each; points httpClient at rec; and configures Twilio for project
// "spore". It returns the AWS config and Registry for handleNotify.
func setupNotifyFixture(t *testing.T, rec *deliveryRecorder) (aws.Config, *Registry) {
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

	// The registry table with the instance_id-index GSI the fan-out queries.
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
		"workspace_key": s("slack#T1"), "platform": s("slack"), "bot_token": s("test-bot-token"),
	})
	for _, u := range []string{"U1", "U2"} {
		put(testRegistryTable, map[string]dynamodbtypes.AttributeValue{
			"user_key": s("slack#T1#" + u), "nickname": s("gpu1"), "instance_id": s("i-0abc"),
		})
		put(testRegistryTable, map[string]dynamodbtypes.AttributeValue{
			"user_key": s("slack#T1#" + u), "nickname": s("_phone"), "phone": s("+1555010000" + u[1:]),
		})
	}

	origHTTP, origCfg := httpClient, cfg
	t.Cleanup(func() { httpClient, cfg = origHTTP, origCfg })
	httpClient = &http.Client{Transport: rec}
	cfg = awsCfg // sendTeamsDMs reads the package config

	t.Setenv("TWILIO_NUMBER_SPORE", "+15550100999")
	t.Setenv("TWILIO_ACCOUNT_SID", "test-account")
	t.Setenv("TWILIO_AUTH_TOKEN", "test-auth")

	return awsCfg, &Registry{client: client, registryTable: testRegistryTable, workspacesTable: testWorkspacesTable}
}

func notifyRequest(t *testing.T) events.APIGatewayProxyRequest {
	t.Helper()
	b, err := json.Marshal(NotifyRequest{Platform: "slack", WorkspaceID: "T1", EventType: "idle_stop_failed",
		InstanceName: "gpu1", InstanceID: "i-0abc", Region: "us-east-1", Detail: "UnsupportedOperation"})
	if err != nil {
		t.Fatal(err)
	}
	return events.APIGatewayProxyRequest{HTTPMethod: "POST", Path: "/notify", Body: string(b)}
}

// TestHandleNotifyDeliversBeforeReturning is #566: Lambda freezes the
// environment once the handler returns, so every Slack DM and SMS must have
// finished by then, and each must have run on a live context (the SMS send used
// to get one already cancelled by a defer).
func TestHandleNotifyDeliversBeforeReturning(t *testing.T) {
	rec := &deliveryRecorder{delay: 150 * time.Millisecond}
	awsCfg, r := setupNotifyFixture(t, rec)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second) // a Lambda invocation's deadline
	defer cancel()
	resp, err := handleNotify(ctx, awsCfg, r, notifyRequest(t))
	done, ctxErrs := rec.snapshot() // as of the moment the handler returned
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("handleNotify = %d, %v", resp.StatusCode, err)
	}

	var dms, sms int
	for _, c := range done {
		switch {
		case c == "slack.com/api/chat.postMessage":
			dms++
		case strings.HasPrefix(c, "api.twilio.com/"):
			sms++
		}
	}
	if dms != 2 || sms != 2 {
		t.Errorf("at return: %d Slack DMs and %d SMS completed, want 2 and 2 (completed: %v)", dms, sms, done)
	}
	for i, e := range ctxErrs {
		if e != nil {
			t.Errorf("%s ran on a dead context: %v", done[i], e)
		}
	}

	// Nothing may still be in flight: a straggler would land here.
	time.Sleep(3 * rec.delay)
	if after, _ := rec.snapshot(); len(after) != len(done) {
		t.Errorf("%d deliveries completed after handleNotify returned: %v", len(after)-len(done), after[len(done):])
	}
}

// TestHandleNotifyBoundedUnderLambdaDeadline checks that a hung Slack/Twilio
// call cannot hold the handler past the invocation's deadline: the fan-out is
// cut off lambdaDeadlineMargin (2s) before it, and the cut-off sends have
// finished by the time the handler returns.
func TestHandleNotifyBoundedUnderLambdaDeadline(t *testing.T) {
	rec := &deliveryRecorder{hang: true}
	awsCfg, r := setupNotifyFixture(t, rec)

	const left = 2500 * time.Millisecond // lambdaDeadlineMargin + 0.5s
	ctx, cancel := context.WithTimeout(context.Background(), left)
	defer cancel()
	start := time.Now()
	resp, err := handleNotify(ctx, awsCfg, r, notifyRequest(t))
	elapsed := time.Since(start)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("handleNotify = %d, %v", resp.StatusCode, err)
	}
	if elapsed >= left-time.Second {
		t.Errorf("handleNotify took %v; with %v left it should stop sending ~2s before the deadline", elapsed, left)
	}
	if done, _ := rec.snapshot(); len(done) != 4 {
		t.Errorf("%d hung sends were cut off before return, want 4: %v", len(done), done)
	}
}
