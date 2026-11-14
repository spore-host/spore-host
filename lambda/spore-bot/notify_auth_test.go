package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

const (
	testNotifyInstance = "i-0abc1234def567890"
	testNotifyAccount  = "111122223333"
)

// testNotifyCaller is the instance-profile session Lambda reports for a
// request signed by testNotifyInstance.
func testNotifyCaller() *notifyCaller {
	return &notifyCaller{
		AccountID: testNotifyAccount,
		ARN:       "arn:aws:sts::" + testNotifyAccount + ":assumed-role/spored-instance-role/" + testNotifyInstance,
	}
}

// #702: /notify refuses anything that is not the named instance's own signed
// request, before it reads the registry (reg is nil here, so a lookup would
// panic).
func TestHandleNotify_RequiresTheInstanceSignature(t *testing.T) {
	body, _ := json.Marshal(NotifyRequest{Platform: "slack", WorkspaceID: "T1", EventType: "completion", InstanceID: testNotifyInstance})
	req := events.APIGatewayProxyRequest{HTTPMethod: "POST", Path: "/notify", Body: string(body)}
	other := "arn:aws:sts::" + testNotifyAccount + ":assumed-role/spored-instance-role/i-0fff1234def567890"
	cases := []struct {
		name   string
		caller *notifyCaller
		want   int
	}{
		{"unsigned (the NONE-auth URL)", nil, 401},
		{"another instance's session", &notifyCaller{AccountID: testNotifyAccount, ARN: other}, 403},
		{"an IAM user", &notifyCaller{AccountID: testNotifyAccount, ARN: "arn:aws:iam::" + testNotifyAccount + ":user/alice"}, 403},
		{"a non-instance session", &notifyCaller{AccountID: testNotifyAccount, ARN: "arn:aws:sts::" + testNotifyAccount + ":assumed-role/admin/alice"}, 403},
		{"ARN account differs from the verified account", &notifyCaller{AccountID: "444455556666", ARN: testNotifyCaller().ARN}, 403},
		{"session name with a suffix", &notifyCaller{AccountID: testNotifyAccount, ARN: testNotifyCaller().ARN + "x"}, 403},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := handleNotify(context.Background(), aws.Config{}, nil, req, tc.caller)
			if err != nil || resp.StatusCode != tc.want {
				t.Errorf("status = %d, err = %v; want %d", resp.StatusCode, err, tc.want)
			}
		})
	}
	if _, _, ok := authorizeNotifier(testNotifyCaller(), testNotifyInstance); !ok {
		t.Error("the instance's own session was refused")
	}
}

// The handler routes a Function URL /notify with the authorizer Lambda set,
// and nil without one.
func TestCallerFromRequests(t *testing.T) {
	var u events.LambdaFunctionURLRequest
	if callerFromFunctionURL(u) != nil {
		t.Error("NONE-auth Function URL request yielded a caller")
	}
	u.RequestContext.Authorizer = &events.LambdaFunctionURLRequestContextAuthorizerDescription{
		IAM: &events.LambdaFunctionURLRequestContextAuthorizerIAMDescription{AccountID: testNotifyAccount, UserARN: testNotifyCaller().ARN},
	}
	if c := callerFromFunctionURL(u); c == nil || *c != *testNotifyCaller() {
		t.Errorf("AWS_IAM Function URL caller = %+v", c)
	}

	var a events.APIGatewayProxyRequest
	if callerFromAPIGateway(a) != nil {
		t.Error("unauthenticated API Gateway request yielded a caller")
	}
	a.RequestContext.Identity.UserArn = testNotifyCaller().ARN
	a.RequestContext.Identity.AccountID = testNotifyAccount
	if c := callerFromAPIGateway(a); c == nil || *c != *testNotifyCaller() {
		t.Errorf("IAM API Gateway caller = %+v", c)
	}
}

func TestNotifyRegistrationCheck(t *testing.T) {
	s := func(v string) dynamodbtypes.AttributeValue { return &dynamodbtypes.AttributeValueMemberS{Value: v} }
	reg := func(userKey, acct, role string) map[string]dynamodbtypes.AttributeValue {
		m := map[string]dynamodbtypes.AttributeValue{"user_key": s(userKey), "instance_id": s(testNotifyInstance)}
		if acct != "" {
			m["aws_account_id"] = s(acct)
		}
		if role != "" {
			m["role_arn"] = s(role)
		}
		return m
	}
	const other = "444455556666"
	cases := []struct {
		name  string
		items []map[string]dynamodbtypes.AttributeValue
		want  instanceRegistration
	}{
		{"unregistered: webhook only", nil, instanceRegistration{}},
		{"registered in the workspace, caller's account", []map[string]dynamodbtypes.AttributeValue{reg("slack#T1#U1", testNotifyAccount, "")}, instanceRegistration{Registered: true}},
		{"account from role_arn", []map[string]dynamodbtypes.AttributeValue{reg("slack#T1#U1", "", "arn:aws:iam::"+testNotifyAccount+":role/spawn-bot")}, instanceRegistration{Registered: true}},
		{"notify-only sub in the workspace, account bound elsewhere", []map[string]dynamodbtypes.AttributeValue{reg("slack#T1#U2", "", ""), reg("slack#T9#U1", testNotifyAccount, "")}, instanceRegistration{Registered: true}},
		{"no account known: no DMs (fail closed)", []map[string]dynamodbtypes.AttributeValue{reg("slack#T1#U1", "", "")}, instanceRegistration{}},
		{"registered under another account: refused", []map[string]dynamodbtypes.AttributeValue{reg("slack#T1#U1", other, "")}, instanceRegistration{ForeignAccount: true}},
		{"registered elsewhere only, caller's account", []map[string]dynamodbtypes.AttributeValue{reg("slack#T9#U1", testNotifyAccount, "")}, instanceRegistration{}},
		{"prefix is exact: T1 is not T10", []map[string]dynamodbtypes.AttributeValue{reg("slack#T10#U1", testNotifyAccount, "")}, instanceRegistration{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := notifyRegistrationCheck(tc.items, "slack", "T1", testNotifyAccount); got != tc.want {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

// Caller-written text cannot form Slack links or mentions, close its code
// block, or carry control characters; malformed DNS names and regions are
// dropped rather than rendered.
func TestSanitizeAndEscapeNotify(t *testing.T) {
	nr := sanitizeNotify(NotifyRequest{
		EventType:    "pre_stop_failed",
		InstanceID:   testNotifyInstance,
		InstanceName: "gpu<!channel>\u202e\r\n" + strings.Repeat("x", 300),
		Detail:       "line1\n```\n<https://evil.example|click here> & run curl | sh",
		DNSName:      "evil.example/<x>",
		Region:       "us-east-1\nURL: https://evil.example",
	})
	if len([]rune(nr.InstanceName)) > maxNotifyName || strings.ContainsAny(nr.InstanceName, "\r\n\u202e") {
		t.Errorf("InstanceName not bounded: %q", nr.InstanceName)
	}
	if nr.DNSName != "" || nr.Region != "" {
		t.Errorf("malformed DNSName/Region kept: %q %q", nr.DNSName, nr.Region)
	}
	msg := formatNotification(nr)
	for _, bad := range []string{"<!channel>", "<https://", "URL: https://evil"} {
		if strings.Contains(msg, bad) {
			t.Errorf("message contains %q:\n%s", bad, msg)
		}
	}
	if strings.Count(msg, "```") != 2 {
		t.Errorf("Detail closed its own code block:\n%s", msg)
	}
	if !strings.Contains(msg, "&lt;!channel&gt;") || !strings.Contains(msg, "&amp; run") {
		t.Errorf("text not escaped:\n%s", msg)
	}

	ok := sanitizeNotify(NotifyRequest{DNSName: "gpu1.abc123.spore.host", Region: "ap-southeast-2"})
	if ok.DNSName != "gpu1.abc123.spore.host" || ok.Region != "ap-southeast-2" {
		t.Errorf("well-formed DNSName/Region dropped: %+v", ok)
	}
}
