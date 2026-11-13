package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	spawnclient "github.com/spore-host/spawn/pkg/aws"
)

const testTwilioToken = "test-twilio-auth-token"

// twilioRequest builds a webhook request; sign it with signTwilio.
func twilioRequest(form url.Values) events.APIGatewayV2HTTPRequest {
	req := events.APIGatewayV2HTTPRequest{Body: form.Encode(), Headers: map[string]string{}}
	req.RequestContext.DomainName = "api.example.test"
	req.RequestContext.HTTP.Method = "POST"
	req.RequestContext.HTTP.Path = "/v1/sms/incoming"
	return req
}

// signTwilio computes the signature the way Twilio documents it, independently
// of validateTwilioSignature.
func signTwilio(req *events.APIGatewayV2HTTPRequest, form url.Values, token string) {
	u := "https://" + req.RequestContext.DomainName + req.RequestContext.HTTP.Path
	if req.RawQueryString != "" {
		u += "?" + req.RawQueryString
	}
	keys := make([]string, 0, len(form))
	for k := range form {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		for _, v := range form[k] {
			u += k + v
		}
	}
	m := hmac.New(sha1.New, []byte(token))
	m.Write([]byte(u))
	req.Headers["x-twilio-signature"] = base64.StdEncoding.EncodeToString(m.Sum(nil))
}

// #696: the webhook must fail closed in every environment. Each case returns
// before any AWS call: refusals by design, the accepted ones because an empty
// form has no To/From and gets an empty TwiML reply.
func TestHandleSMSIncoming_FailsClosed(t *testing.T) {
	empty := url.Values{"Body": {""}}
	cases := []struct {
		name     string
		token    string
		env      map[string]string
		sign     string // token to sign with; "" = unsigned
		want     int
		base64ed bool
	}{
		{"no token, integ (the DEPLOY.md shape)", "", map[string]string{"SPORE_ENV": "integ"}, "", http.StatusServiceUnavailable, false},
		{"no token, production", "", map[string]string{"SPORE_ENV": "production"}, "", http.StatusServiceUnavailable, false},
		{"no token, skip flag set", "", map[string]string{"SKIP_TWILIO_SIGNATURE": "true"}, "", http.StatusServiceUnavailable, false},
		{"token, unsigned, skip flag set", testTwilioToken, map[string]string{"SKIP_TWILIO_SIGNATURE": "true"}, "", http.StatusForbidden, false},
		{"token, unsigned", testTwilioToken, nil, "", http.StatusForbidden, false},
		{"token, wrong signing key", testTwilioToken, nil, "attacker-token", http.StatusForbidden, false},
		{"token, valid signature", testTwilioToken, nil, testTwilioToken, http.StatusOK, false},
		{"token, valid signature, base64 body", testTwilioToken, nil, testTwilioToken, http.StatusOK, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TWILIO_AUTH_TOKEN", tc.token)
			t.Setenv("SPORE_ENV", "")
			t.Setenv("SKIP_TWILIO_SIGNATURE", "")
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			req := twilioRequest(empty)
			if tc.sign != "" {
				signTwilio(&req, empty, tc.sign)
			}
			if tc.base64ed {
				req.Body = base64.StdEncoding.EncodeToString([]byte(req.Body))
				req.IsBase64Encoded = true
			}
			want := tc.want
			if unsignedTwilioAllowed && tc.env["SKIP_TWILIO_SIGNATURE"] == "true" {
				want = http.StatusOK // only in a -tags twilio_unsigned build
			}
			resp, err := handler(context.Background(), req)
			if err != nil {
				t.Fatalf("transport error: %v", err)
			}
			if resp.StatusCode != want {
				t.Errorf("status = %d, want %d (body %s)", resp.StatusCode, want, resp.Body)
			}
		})
	}
}

func TestValidateTwilioSignature(t *testing.T) {
	form := url.Values{"To": {"+15550100001"}, "From": {"+15550100002"}, "Body": {"1"}}
	req := twilioRequest(form)
	req.RawQueryString = "x=1"
	signTwilio(&req, form, testTwilioToken)
	if !validateTwilioSignature(req, testTwilioToken) {
		t.Fatal("valid signature (with query string) rejected")
	}
	tampered := req
	tampered.Body = strings.Replace(req.Body, "Body=1", "Body=4", 1)
	if validateTwilioSignature(tampered, testTwilioToken) {
		t.Error("tampered body accepted")
	}
	if validateTwilioSignature(req, "") {
		t.Error("empty token accepted")
	}
	noSig := twilioRequest(form)
	if validateTwilioSignature(noSig, testTwilioToken) {
		t.Error("missing signature accepted")
	}
}

// fakeInstances records what an SMS reply did.
type fakeInstances struct {
	insts   []spawnclient.InstanceInfo
	started []string
	tagged  map[string]map[string]string
}

func (f *fakeInstances) ListInstances(context.Context, string, string) ([]spawnclient.InstanceInfo, error) {
	return f.insts, nil
}

func (f *fakeInstances) StartInstance(_ context.Context, _, id string) error {
	f.started = append(f.started, id)
	return nil
}

func (f *fakeInstances) GetInstanceState(context.Context, string, string) (string, error) {
	return "stopped", nil
}

func (f *fakeInstances) UpdateInstanceTags(_ context.Context, _, id string, tags map[string]string) error {
	if f.tagged == nil {
		f.tagged = map[string]map[string]string{}
	}
	f.tagged[id] = tags
	return nil
}

// #698: a pending reply acts only on an instance spawn manages.
func TestExecuteAction_OnlyManagedInstances(t *testing.T) {
	managed := spawnclient.InstanceInfo{InstanceID: "i-0aaa", Region: "us-east-1", Tags: map[string]string{"spawn:managed": "true"}}
	for _, action := range []string{"start", "status", "extend:1h", "keep"} {
		t.Run(action, func(t *testing.T) {
			f := &fakeInstances{insts: []spawnclient.InstanceInfo{managed}}
			p := &smsPendingNotification{InstanceID: "i-0bbb", Region: "us-east-1"}
			if _, err := executeAction(context.Background(), f, p, action); err == nil {
				t.Error("acted on an instance ListInstances did not return")
			}
			if len(f.started) != 0 || len(f.tagged) != 0 {
				t.Errorf("side effects on refusal: started=%v tagged=%v", f.started, f.tagged)
			}

			p.InstanceID = "i-0aaa"
			if _, err := executeAction(context.Background(), f, p, action); err != nil {
				t.Errorf("managed instance refused: %v", err)
			}
		})
	}
}

// fakeRegistry records registry writes.
type fakeRegistry struct {
	puts    []map[string]dynamodbtypes.AttributeValue
	updates []map[string]dynamodbtypes.AttributeValue
}

func (f *fakeRegistry) PutItem(_ context.Context, in *dynamodb.PutItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	f.puts = append(f.puts, in.Item)
	return &dynamodb.PutItemOutput{}, nil
}

func (f *fakeRegistry) UpdateItem(_ context.Context, in *dynamodb.UpdateItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	f.updates = append(f.updates, in.Key)
	return &dynamodb.UpdateItemOutput{}, nil
}

func sAttr(m map[string]dynamodbtypes.AttributeValue, k string) string {
	if v, ok := m[k].(*dynamodbtypes.AttributeValueMemberS); ok {
		return v.Value
	}
	return ""
}

// #698: the registry row is the key's own identity, never one from the body.
func TestRegisterPhone_Ownership(t *testing.T) {
	bound := &Principal{KeyID: "k1", Project: "acme", UserKey: "slack#T1#Ualice"}
	unbound := &Principal{KeyID: "k2", Project: "acme"}
	req := func(body string) events.APIGatewayV2HTTPRequest { return events.APIGatewayV2HTTPRequest{Body: body} }

	cases := []struct {
		name   string
		method string
		p      *Principal
		body   string
		want   int
	}{
		{"victim's user_key refused", "POST", bound, `{"phone":"+15550100001","user_key":"slack#T1#Uvictim"}`, http.StatusForbidden},
		{"victim's user_key refused on delete", "DELETE", bound, `{"phone":"+15550100001","user_key":"slack#T1#Uvictim"}`, http.StatusForbidden},
		{"unbound key refused", "POST", unbound, `{"phone":"+15550100001","user_key":"slack#T1#Uvictim"}`, http.StatusForbidden},
		{"unbound key refused without user_key", "POST", unbound, `{"phone":"+15550100001"}`, http.StatusForbidden},
		{"bad phone refused", "POST", bound, `{"phone":"call me"}`, http.StatusBadRequest},
		{"own user_key, explicit", "POST", bound, `{"phone":"+15550100001","user_key":"slack#T1#Ualice"}`, http.StatusOK},
		{"own user_key, implied", "POST", bound, `{"phone":"+15550100001"}`, http.StatusOK},
		{"own delete", "DELETE", bound, `{"phone":"+15550100001"}`, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeRegistry{}
			resp := registerPhone(context.Background(), f, "reg", tc.method, req(tc.body), tc.p)
			if resp.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d (%s)", resp.StatusCode, tc.want, resp.Body)
			}
			writes := append(append([]map[string]dynamodbtypes.AttributeValue{}, f.puts...), f.updates...)
			if tc.want != http.StatusOK {
				if len(writes) != 0 {
					t.Errorf("refused request wrote %v", writes)
				}
				return
			}
			if len(writes) != 1 {
				t.Fatalf("want one write, got %d", len(writes))
			}
			if got := sAttr(writes[0], "user_key"); got != bound.UserKey {
				t.Errorf("wrote user_key %q, want %q", got, bound.UserKey)
			}
			if tc.method == "POST" && sAttr(writes[0], "registered_by") != bound.KeyID {
				t.Errorf("registered_by not recorded")
			}
		})
	}
}

// The handler-level route still demands a key before registration.
func TestHandler_RegisterNeedsAPIKey(t *testing.T) {
	req := events.APIGatewayV2HTTPRequest{Body: `{"phone":"+15550100001","user_key":"x"}`}
	req.RequestContext.HTTP.Method = "POST"
	req.RequestContext.HTTP.Path = "/v1/notifications/register"
	resp, err := handler(context.Background(), req)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, err = %v; want 401", resp.StatusCode, err)
	}
}
