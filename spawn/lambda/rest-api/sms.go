package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	spawnclient "github.com/scttfrdmn/spore-host/spawn/pkg/aws"
)

const pendingTable = "spore-sms-pending"

// PendingNotification tracks a sent SMS we're waiting for a reply on.
type PendingNotification struct {
	// Key: twilioNumber#userPhone — uniquely scopes replies to one project+user pair
	TwilioNumber string            // the Twilio number that sent the message (identifies the project)
	UserPhone    string            // the user's phone number
	Project      string            // "spore", "prism", etc.
	InstanceID   string
	Region       string
	EventType    string
	Options      map[string]string // "1" -> "extend:1h", etc.
	ExpiresAt    int64
}

// pendingKey returns the DynamoDB key for a (twilioNumber, userPhone) pair.
// This ensures replies to +SPORE number only resolve spore.host pending state,
// and replies to +PRISM number only resolve prism pending state.
func pendingKey(twilioNumber, userPhone string) string {
	return twilioNumber + "#" + userPhone
}

// projectNumber returns the Twilio phone number for a project.
// Looks up TWILIO_NUMBER_{PROJECT} (e.g. TWILIO_NUMBER_SPORE, TWILIO_NUMBER_PRISM).
func projectNumber(project string) string {
	return os.Getenv("TWILIO_NUMBER_" + strings.ToUpper(project))
}

// SendSMS sends an outbound SMS from the project's dedicated Twilio number.
// The from number identifies the sending application to the recipient.
func SendSMS(ctx context.Context, project, toPhone, message string) error {
	accountSID := os.Getenv("TWILIO_ACCOUNT_SID")
	authToken := os.Getenv("TWILIO_AUTH_TOKEN")
	fromNumber := projectNumber(project)

	if accountSID == "" || authToken == "" || fromNumber == "" {
		return fmt.Errorf("Twilio not configured for project %q (need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER_%s)", project, strings.ToUpper(project))
	}

	apiURL := fmt.Sprintf("https://api.twilio.com/2010-04-01/Accounts/%s/Messages.json", accountSID)
	body := url.Values{
		"To":   {toPhone},
		"From": {fromNumber},
		"Body": {message},
	}

	req, err := http.NewRequestWithContext(ctx, "POST", apiURL, strings.NewReader(body.Encode()))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.SetBasicAuth(accountSID, authToken)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("twilio request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("twilio %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

// StorePending saves a pending notification keyed by (twilioNumber, userPhone).
func StorePending(ctx context.Context, n PendingNotification) error {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	if err != nil {
		return err
	}
	client := dynamodb.NewFromConfig(cfg)

	expires := time.Now().Add(15 * time.Minute).Unix()
	_, err = client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(pendingTable),
		Item: map[string]dynamodbtypes.AttributeValue{
			"pending_key": &dynamodbtypes.AttributeValueMemberS{Value: pendingKey(n.TwilioNumber, n.UserPhone)},
			"project":     &dynamodbtypes.AttributeValueMemberS{Value: n.Project},
			"instance_id": &dynamodbtypes.AttributeValueMemberS{Value: n.InstanceID},
			"region":      &dynamodbtypes.AttributeValueMemberS{Value: n.Region},
			"event_type":  &dynamodbtypes.AttributeValueMemberS{Value: n.EventType},
			"options":     &dynamodbtypes.AttributeValueMemberS{Value: encodeOptions(n.Options)},
			"ttl":         &dynamodbtypes.AttributeValueMemberN{Value: fmt.Sprintf("%d", expires)},
		},
	})
	return err
}

// BuildSMSMessage formats the outbound SMS for an event type with a numbered menu.
func BuildSMSMessage(instanceName, eventType string, extraInfo map[string]string) (string, map[string]string) {
	options := map[string]string{}
	var msg strings.Builder

	switch eventType {
	case "ttl_warning":
		remaining := extraInfo["remaining"]
		fmt.Fprintf(&msg, "%s terminates in %s.\n\n1 · Extend 1h\n2 · Extend 2h\n4 · Extend 4h\n0 · Dismiss", instanceName, remaining)
		options["1"] = "extend:1h"
		options["2"] = "extend:2h"
		options["4"] = "extend:4h"
		options["0"] = "dismiss"

	case "idle_warning":
		idle := extraInfo["idle_duration"]
		remaining := extraInfo["remaining"]
		fmt.Fprintf(&msg, "%s idle %s, stops in %s.\n\n1 · Keep running\n0 · Dismiss", instanceName, idle, remaining)
		options["1"] = "keep"
		options["0"] = "dismiss"

	case "idle_stopped", "idle_hibernated":
		verb := "stopped"
		if eventType == "idle_hibernated" {
			verb = "hibernated"
		}
		fmt.Fprintf(&msg, "%s %s (idle). Cost so far: %s\n\n1 · Wake instance\n0 · Dismiss", instanceName, verb, extraInfo["cost"])
		options["1"] = "start"
		options["0"] = "dismiss"

	case "ttl_expired":
		fmt.Fprintf(&msg, "%s terminated (TTL). Cumulative cost: %s", instanceName, extraInfo["cost"])

	case "completion":
		fmt.Fprintf(&msg, "%s job done. Cost: %s\n\n1 · Get status\n0 · Dismiss", instanceName, extraInfo["cost"])
		options["1"] = "status"
		options["0"] = "dismiss"

	case "spot_interrupt":
		fmt.Fprintf(&msg, "%s Spot interruption — ~2 min remaining.", instanceName)

	default:
		fmt.Fprintf(&msg, "%s: %s", instanceName, eventType)
	}

	return msg.String(), options
}

// handleSMSIncoming processes a Twilio webhook for an inbound SMS reply.
// The `To` field in the Twilio payload tells us which project's number was texted,
// scoping the reply lookup to that project's pending notifications only.
func handleSMSIncoming(ctx context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	authToken := os.Getenv("TWILIO_AUTH_TOKEN")
	if authToken != "" && !validateTwilioSignature(req, authToken) {
		return errResp(http.StatusForbidden, "invalid Twilio signature"), nil
	}

	params, err := url.ParseQuery(req.Body)
	if err != nil {
		return errResp(http.StatusBadRequest, "invalid body"), nil
	}

	to   := params.Get("To")                      // which Twilio number (= which project)
	from := params.Get("From")                    // user's phone
	body := strings.TrimSpace(params.Get("Body"))

	if to == "" || from == "" || body == "" {
		return twilioResp("")
	}

	pending, err := fetchPending(ctx, pendingKey(to, from))
	if err != nil || pending == nil {
		return twilioResp("No pending notification. Use the spore.host CLI or Slack bot to manage your instances.")
	}

	action, ok := pending.Options[body]
	if !ok {
		return twilioResp(fmt.Sprintf("Reply %q not recognised. Valid: %s", body, buildOptionsHint(pending.Options)))
	}

	if action == "dismiss" {
		clearPending(ctx, pendingKey(to, from))
		return twilioResp("Dismissed.")
	}

	reply, err := executeAction(ctx, pending, action)
	if err != nil {
		return twilioResp(fmt.Sprintf("Error: %v", err))
	}

	clearPending(ctx, pendingKey(to, from))
	return twilioResp(reply)
}

func executeAction(ctx context.Context, p *PendingNotification, action string) (string, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(p.Region))
	if err != nil {
		return "", fmt.Errorf("AWS config: %w", err)
	}
	client := spawnclient.NewClientFromConfig(cfg)

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
		if err := client.UpdateInstanceTags(ctx, p.Region, p.InstanceID, map[string]string{
			"spawn:ttl": dur,
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

// handleNotificationRegister saves or removes a phone number for a user.
func handleNotificationRegister(ctx context.Context, method string, req events.APIGatewayV2HTTPRequest, p *Principal) (events.APIGatewayV2HTTPResponse, error) {
	var body struct {
		Phone   string `json:"phone"`
		UserKey string `json:"user_key"`
	}
	if err := parseJSON(req.Body, &body); err != nil || body.Phone == "" || body.UserKey == "" {
		return errResp(http.StatusBadRequest, "phone and user_key required"), nil
	}

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	if err != nil {
		return errResp(http.StatusInternalServerError, "AWS config error"), nil
	}
	table := os.Getenv("REGISTRY_TABLE")
	if table == "" {
		table = "spore-bot-registry"
	}
	client := dynamodb.NewFromConfig(cfg)

	if method == "DELETE" {
		_, err = client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
			TableName: aws.String(table),
			Key: map[string]dynamodbtypes.AttributeValue{
				"user_key": &dynamodbtypes.AttributeValueMemberS{Value: body.UserKey},
				"nickname": &dynamodbtypes.AttributeValueMemberS{Value: "_phone"},
			},
			UpdateExpression: aws.String("REMOVE phone"),
		})
	} else {
		_, err = client.PutItem(ctx, &dynamodb.PutItemInput{
			TableName: aws.String(table),
			Item: map[string]dynamodbtypes.AttributeValue{
				"user_key": &dynamodbtypes.AttributeValueMemberS{Value: body.UserKey},
				"nickname": &dynamodbtypes.AttributeValueMemberS{Value: "_phone"},
				"phone":    &dynamodbtypes.AttributeValueMemberS{Value: body.Phone},
				"project":  &dynamodbtypes.AttributeValueMemberS{Value: p.Project},
			},
		})
	}
	if err != nil {
		return errResp(http.StatusInternalServerError, fmt.Sprintf("DynamoDB: %v", err)), nil
	}
	verb := "registered"
	if method == "DELETE" {
		verb = "deregistered"
	}
	return jsonResp(http.StatusOK, map[string]string{"status": verb, "phone": body.Phone}), nil
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

func validateTwilioSignature(req events.APIGatewayV2HTTPRequest, authToken string) bool {
	urlStr := "https://" + req.RequestContext.DomainName + req.RequestContext.HTTP.Path
	params, _ := url.ParseQuery(req.Body)
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sb strings.Builder
	for _, k := range keys {
		sb.WriteString(k)
		sb.WriteString(params.Get(k))
	}
	mac := hmac.New(sha1.New, []byte(authToken))
	mac.Write([]byte(urlStr + sb.String()))
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(req.Headers["x-twilio-signature"]))
}

func fetchPending(ctx context.Context, key string) (*PendingNotification, error) {
	cfg, _ := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	client := dynamodb.NewFromConfig(cfg)
	out, err := client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(pendingTable),
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
	return &PendingNotification{
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
	client := dynamodb.NewFromConfig(cfg)
	_, _ = client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(pendingTable),
		Key: map[string]dynamodbtypes.AttributeValue{
			"pending_key": &dynamodbtypes.AttributeValueMemberS{Value: key},
		},
	})
}

func encodeOptions(opts map[string]string) string {
	keys := make([]string, 0, len(opts))
	for k := range opts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+opts[k])
	}
	return strings.Join(parts, ",")
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
