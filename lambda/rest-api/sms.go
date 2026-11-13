package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	spawnclient "github.com/spore-host/spawn/pkg/aws"
)

// SMS pending-reply store, kept local here (mirrors spore-bot/sms_notify.go's own
// copy). This is only the inbound-reply half the REST API needs; spawn's former
// pkg/sms was retired (spawn#293), so these types live with their consumer.
const smsPendingTable = "spore-sms-pending"

// smsPendingNotification tracks a sent SMS while waiting for the user's numbered reply.
type smsPendingNotification struct {
	TwilioNumber string // the Twilio number that sent the message (identifies the project)
	UserPhone    string // the recipient's phone number
	Project      string // "spore", "prism", etc.
	InstanceID   string
	Region       string
	EventType    string
	Options      map[string]string // "1" -> "extend:1h", "0" -> "dismiss", etc.
}

// smsPendingKey returns the DynamoDB primary key for a (twilioNumber, userPhone) pair.
func smsPendingKey(twilioNumber, userPhone string) string {
	return twilioNumber + "#" + userPhone
}

// handleSMSIncoming processes a Twilio webhook for an inbound SMS reply.
// The To field identifies the project; the From field identifies the user.
func handleSMSIncoming(ctx context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	if resp, ok := checkTwilioRequest(req); !ok {
		return resp, nil
	}

	rawBody := req.Body
	if req.IsBase64Encoded {
		if decoded, err := base64.StdEncoding.DecodeString(rawBody); err == nil {
			rawBody = string(decoded)
		}
	}
	params, err := url.ParseQuery(rawBody)
	if err != nil {
		return errResp(http.StatusBadRequest, "invalid body"), nil
	}

	to := params.Get("To")
	from := params.Get("From")
	body := strings.TrimSpace(params.Get("Body"))

	if to == "" || from == "" || body == "" {
		return twilioResp("")
	}

	pending, err := fetchPending(ctx, smsPendingKey(to, from))
	if err != nil || pending == nil {
		return twilioResp("No pending notification. Use the spore.host CLI or Slack bot to manage your instances.")
	}

	action, ok := pending.Options[body]
	if !ok {
		return twilioResp(fmt.Sprintf("Reply %q not recognised. Valid: %s", body, buildOptionsHint(pending.Options)))
	}

	if action == "dismiss" {
		clearPending(ctx, smsPendingKey(to, from))
		return twilioResp("Dismissed.")
	}

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(pending.Region))
	if err != nil {
		return twilioResp("Error: AWS config")
	}
	reply, err := executeAction(ctx, spawnclient.NewClientFromConfig(cfg), pending, action)
	if err != nil {
		return twilioResp(fmt.Sprintf("Error: %v", err))
	}

	clearPending(ctx, smsPendingKey(to, from))
	return twilioResp(reply)
}

// checkTwilioRequest authenticates a Twilio webhook. ok=false means refuse it
// with resp.
//
// The auth token is required in every environment (#696). It used to be
// required only when SPORE_ENV was production, so a deployment following
// infra/DEPLOY.md (SPORE_ENV=integ, no token, a public Function URL) checked no
// signature at all, and anyone could start instances or extend TTLs by
// posting a reply. Unset now means 503, never "accept". SKIP_TWILIO_SIGNATURE
// is honoured only in a binary built with the twilio_unsigned tag, which
// nothing deploys (see twilio_unsigned.go).
func checkTwilioRequest(req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, bool) {
	if unsignedTwilioAllowed && os.Getenv("SKIP_TWILIO_SIGNATURE") == "true" {
		return events.APIGatewayV2HTTPResponse{}, true
	}
	authToken := os.Getenv("TWILIO_AUTH_TOKEN")
	if authToken == "" {
		return errResp(http.StatusServiceUnavailable, "SMS not configured"), false
	}
	if !validateTwilioSignature(req, authToken) {
		return errResp(http.StatusForbidden, "invalid Twilio signature"), false
	}
	return events.APIGatewayV2HTTPResponse{}, true
}

// instanceOps is the part of spawn's client an SMS reply can drive.
type instanceOps interface {
	ListInstances(ctx context.Context, region, stateFilter string) ([]spawnclient.InstanceInfo, error)
	StartInstance(ctx context.Context, region, instanceID string) error
	GetInstanceState(ctx context.Context, region, instanceID string) (string, error)
	UpdateInstanceTags(ctx context.Context, region, instanceID string, tags map[string]string) error
}

func executeAction(ctx context.Context, client instanceOps, p *smsPendingNotification, action string) (string, error) {
	// Re-resolve the instance before acting on it (#698). ListInstances returns
	// only spawn:managed=true instances, so a pending row naming any other
	// instance (a stale row, or one written by whoever can write the table)
	// acts on nothing.
	insts, err := client.ListInstances(ctx, p.Region, "")
	if err != nil {
		return "", fmt.Errorf("look up instance: %w", err)
	}
	var target *spawnclient.InstanceInfo
	for i := range insts {
		if insts[i].InstanceID == p.InstanceID {
			target = &insts[i]
			break
		}
	}
	if target == nil {
		return "", fmt.Errorf("instance %s is not a spore.host instance", p.InstanceID)
	}

	switch {
	case action == "start":
		if err := client.StartInstance(ctx, p.Region, p.InstanceID); err != nil {
			return "", err
		}
		return "Waking instance. Use `spawn connect` to reconnect when running.", nil

	case action == "status":
		state, err := client.GetInstanceState(ctx, p.Region, p.InstanceID)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("Instance state: %s", state), nil

	case strings.HasPrefix(action, "extend:"):
		dur := strings.TrimPrefix(action, "extend:")
		if _, err := capDuration(dur); err != nil {
			return "", err
		}
		extendDuration, err := time.ParseDuration(dur)
		if err != nil {
			return "", fmt.Errorf("invalid duration: %w", err)
		}
		// Push the absolute deadline forward and write BOTH tags. Writing only
		// spawn:ttl is a silent no-op — spored honors spawn:ttl-deadline
		// (same bug class as spore-host#371 / spore-host-mcp#11).
		var newDeadline time.Time
		if dl, ok := target.Tags["spawn:ttl-deadline"]; ok {
			if parsed, perr := time.Parse(time.RFC3339, dl); perr == nil {
				newDeadline = parsed.Add(extendDuration)
			}
		} else if cur, cerr := time.ParseDuration(target.TTL); cerr == nil {
			newDeadline = time.Now().Add(cur).Add(extendDuration)
		}
		if newDeadline.IsZero() {
			newDeadline = time.Now().Add(extendDuration)
		}
		// Safety floor (2026-06 audit, M-corr): never set a deadline earlier than
		// the requested duration from now — a past/expired existing deadline must
		// not reap the instance the moment the user replies to keep it.
		if floor := time.Now().Add(extendDuration); newDeadline.Before(floor) {
			newDeadline = floor
		}
		if err := client.UpdateInstanceTags(ctx, p.Region, p.InstanceID, map[string]string{
			"spawn:ttl":          dur,
			"spawn:ttl-deadline": newDeadline.UTC().Format(time.RFC3339),
		}); err != nil {
			return "", err
		}
		return fmt.Sprintf("TTL extended by %s.", dur), nil

	case action == "keep":
		if err := client.UpdateInstanceTags(ctx, p.Region, p.InstanceID, map[string]string{
			"spawn:idle-reset": time.Now().UTC().Format(time.RFC3339),
		}); err != nil {
			return "", err
		}
		return "Idle timer reset. Instance will keep running.", nil

	default:
		return "", fmt.Errorf("unknown action %q", action)
	}
}

// e164Pattern is an E.164 phone number: "+", a non-zero digit, 7 to 15 digits.
var e164Pattern = regexp.MustCompile(`^\+[1-9][0-9]{6,14}$`)

// registryWriter is the part of the DynamoDB client registration uses.
type registryWriter interface {
	PutItem(ctx context.Context, in *dynamodb.PutItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
}

// handleNotificationRegister saves or removes a phone number for a user.
func handleNotificationRegister(ctx context.Context, method string, req events.APIGatewayV2HTTPRequest, p *Principal) (events.APIGatewayV2HTTPResponse, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	if err != nil {
		return errResp(http.StatusInternalServerError, "AWS config error"), nil
	}
	table := os.Getenv("REGISTRY_TABLE")
	if table == "" {
		table = "spore-bot-registry"
	}
	return registerPhone(ctx, dynamodb.NewFromConfig(cfg), table, method, req, p), nil
}

// registerPhone writes or removes the caller's own _phone row.
//
// The row's user_key comes from the API key, never from the request (#698).
// It used to be taken from the body, so any key holder could point another
// user's SMS notifications (and the replies that start instances and extend
// TTLs) at their own phone, or delete that user's registration. A key whose
// row carries no user_key can register nothing; a body user_key, if sent,
// must equal the key's.
func registerPhone(ctx context.Context, client registryWriter, table, method string, req events.APIGatewayV2HTTPRequest, p *Principal) events.APIGatewayV2HTTPResponse {
	var body struct {
		Phone   string `json:"phone"`
		UserKey string `json:"user_key"`
	}
	if err := parseJSON(req.Body, &body); err != nil || body.Phone == "" {
		return errResp(http.StatusBadRequest, "phone required")
	}
	if !e164Pattern.MatchString(body.Phone) {
		return errResp(http.StatusBadRequest, "phone must be in E.164 form, e.g. +15555550100")
	}
	if p == nil || p.UserKey == "" {
		return errResp(http.StatusForbidden, "this API key is not bound to a chat identity, so it cannot register a phone")
	}
	if body.UserKey != "" && body.UserKey != p.UserKey {
		return errResp(http.StatusForbidden, "user_key does not match this API key")
	}

	key := map[string]dynamodbtypes.AttributeValue{
		"user_key": &dynamodbtypes.AttributeValueMemberS{Value: p.UserKey},
		"nickname": &dynamodbtypes.AttributeValueMemberS{Value: "_phone"},
	}
	var err error
	if method == "DELETE" {
		_, err = client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
			TableName:        aws.String(table),
			Key:              key,
			UpdateExpression: aws.String("REMOVE phone"),
		})
	} else {
		item := map[string]dynamodbtypes.AttributeValue{
			"phone":         &dynamodbtypes.AttributeValueMemberS{Value: body.Phone},
			"project":       &dynamodbtypes.AttributeValueMemberS{Value: p.Project},
			"registered_by": &dynamodbtypes.AttributeValueMemberS{Value: p.KeyID},
		}
		for k, v := range key {
			item[k] = v
		}
		_, err = client.PutItem(ctx, &dynamodb.PutItemInput{
			TableName: aws.String(table),
			Item:      item,
		})
	}
	if err != nil {
		log.Printf("notifications/register: %s failed for keyid=%s: %v", method, p.KeyID, err)
		return errResp(http.StatusInternalServerError, "registry write failed")
	}
	verb := "registered"
	if method == "DELETE" {
		verb = "deregistered"
	}
	return jsonResp(http.StatusOK, map[string]string{"status": verb, "phone": body.Phone})
}

func twilioResp(msg string) (events.APIGatewayV2HTTPResponse, error) {
	var body string
	if msg == "" {
		body = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`
	} else {
		body = fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>%s</Message></Response>`, msg)
	}
	return events.APIGatewayV2HTTPResponse{
		StatusCode: 200,
		Headers:    map[string]string{"Content-Type": "application/xml"},
		Body:       body,
	}, nil
}

// validateTwilioSignature checks X-Twilio-Signature: base64 HMAC-SHA1, keyed
// by the auth token, of the full request URL followed by every POST
// parameter's name and value, sorted by name. It reads the decoded body (a
// Function URL may base64-encode it) and includes the query string, as Twilio
// does when it signs.
func validateTwilioSignature(req events.APIGatewayV2HTTPRequest, authToken string) bool {
	sig := req.Headers["x-twilio-signature"]
	if sig == "" || authToken == "" {
		return false
	}
	urlStr := "https://" + req.RequestContext.DomainName + req.RequestContext.HTTP.Path
	if req.RawQueryString != "" {
		urlStr += "?" + req.RawQueryString
	}
	rawBody := req.Body
	if req.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(rawBody)
		if err != nil {
			return false
		}
		rawBody = string(decoded)
	}
	params, err := url.ParseQuery(rawBody)
	if err != nil {
		return false
	}
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sb strings.Builder
	for _, k := range keys {
		for _, v := range params[k] {
			sb.WriteString(k)
			sb.WriteString(v)
		}
	}
	mac := hmac.New(sha1.New, []byte(authToken))
	mac.Write([]byte(urlStr + sb.String()))
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(sig))
}

func fetchPending(ctx context.Context, key string) (*smsPendingNotification, error) {
	cfg, _ := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	out, err := dynamodb.NewFromConfig(cfg).GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(smsPendingTable),
		Key: map[string]dynamodbtypes.AttributeValue{
			"pending_key": &dynamodbtypes.AttributeValueMemberS{Value: key},
		},
	})
	if err != nil || out.Item == nil {
		return nil, nil
	}
	get := func(k string) string {
		if v, ok := out.Item[k].(*dynamodbtypes.AttributeValueMemberS); ok {
			return v.Value
		}
		return ""
	}
	parts := strings.SplitN(key, "#", 2)
	twilioNum, userPhone := "", key
	if len(parts) == 2 {
		twilioNum, userPhone = parts[0], parts[1]
	}
	return &smsPendingNotification{
		TwilioNumber: twilioNum,
		UserPhone:    userPhone,
		Project:      get("project"),
		InstanceID:   get("instance_id"),
		Region:       get("region"),
		EventType:    get("event_type"),
		Options:      decodeOptions(get("options")),
	}, nil
}

func clearPending(ctx context.Context, key string) {
	cfg, _ := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	_, _ = dynamodb.NewFromConfig(cfg).DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(smsPendingTable),
		Key: map[string]dynamodbtypes.AttributeValue{
			"pending_key": &dynamodbtypes.AttributeValueMemberS{Value: key},
		},
	})
}

func decodeOptions(s string) map[string]string {
	m := map[string]string{}
	for _, part := range strings.Split(s, ",") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) == 2 {
			m[kv[0]] = kv[1]
		}
	}
	return m
}

func buildOptionsHint(opts map[string]string) string {
	keys := make([]string, 0, len(opts))
	for k := range opts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return strings.Join(keys, ", ")
}
