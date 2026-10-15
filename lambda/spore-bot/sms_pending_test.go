package main

import (
	"bytes"
	"context"
	"log"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// captureLog redirects the standard logger for the rest of the test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	orig, flags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(orig); log.SetFlags(flags) })
	return &buf
}

func ttlWarning() NotifyRequest {
	return NotifyRequest{Platform: "slack", WorkspaceID: "T1", EventType: "ttl_warning",
		InstanceName: "gpu1", InstanceID: "i-0abc", Region: "us-east-1"}
}

// TestSendUserSMSLogsAPendingStoreFailure is #576: a failed write to
// spore-sms-pending (AccessDenied in production, a missing table here) used to
// be discarded, so replies silently matched nothing. It must be logged, and the
// SMS itself must still be sent.
func TestSendUserSMSLogsAPendingStoreFailure(t *testing.T) {
	rec := &deliveryRecorder{}
	_, reg := setupNotifyFixture(t, rec) // no spore-sms-pending table
	logs := captureLog(t)

	sendUserSMS(context.Background(), reg, ttlWarning(), "i-0abc")

	out := logs.String()
	if n := strings.Count(out, "replies to this SMS will not be matched"); n != 2 {
		t.Errorf("want the pending-store failure logged once per recipient (2), got %d; log:\n%s", n, out)
	}
	if !strings.Contains(out, smsPendingTable) {
		t.Errorf("log does not name the table %s:\n%s", smsPendingTable, out)
	}
	if strings.Contains(out, "+1555010000") {
		t.Errorf("pending-store failure log contains a phone number:\n%s", out)
	}
	done, _ := rec.snapshot()
	sent := 0
	for _, c := range done {
		if strings.HasPrefix(c, "api.twilio.com") {
			sent++
		}
	}
	if sent != 2 {
		t.Errorf("want both SMS sent despite the store failure, got %d (%v)", sent, done)
	}
}

// TestSendUserSMSStoresPendingReplies: with the table present, each recipient
// gets a pending record keyed "<from>#<to>" and nothing is logged as an error.
func TestSendUserSMSStoresPendingReplies(t *testing.T) {
	rec := &deliveryRecorder{}
	_, reg := setupNotifyFixture(t, rec)
	ctx := context.Background()
	if _, err := reg.client.CreateTable(ctx, &dynamodb.CreateTableInput{
		TableName:            aws.String(smsPendingTable),
		BillingMode:          dynamodbtypes.BillingModePayPerRequest,
		AttributeDefinitions: []dynamodbtypes.AttributeDefinition{{AttributeName: aws.String("pending_key"), AttributeType: dynamodbtypes.ScalarAttributeTypeS}},
		KeySchema:            []dynamodbtypes.KeySchemaElement{{AttributeName: aws.String("pending_key"), KeyType: dynamodbtypes.KeyTypeHash}},
	}); err != nil {
		t.Fatalf("create %s: %v", smsPendingTable, err)
	}
	logs := captureLog(t)

	sendUserSMS(ctx, reg, ttlWarning(), "i-0abc")

	if strings.Contains(logs.String(), "ERROR") {
		t.Errorf("unexpected error log:\n%s", logs.String())
	}
	for _, to := range []string{"+15550100001", "+15550100002"} {
		got, err := reg.client.GetItem(ctx, &dynamodb.GetItemInput{
			TableName: aws.String(smsPendingTable),
			Key:       map[string]dynamodbtypes.AttributeValue{"pending_key": &dynamodbtypes.AttributeValueMemberS{Value: "+15550100999#" + to}},
		})
		if err != nil || got.Item == nil {
			t.Fatalf("no pending record for %s: %v", to, err)
		}
		if v := got.Item["instance_id"].(*dynamodbtypes.AttributeValueMemberS).Value; v != "i-0abc" {
			t.Errorf("pending record for %s has instance_id %q", to, v)
		}
	}
}
