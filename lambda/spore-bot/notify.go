package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// NotifyRequest is sent by spored when a lifecycle event fires.
// Authentication is the registry-membership gate in handleNotify (#374); the
// former PKCS#7/identity-document fields were removed with the log-only cert
// path. Unknown JSON fields from older senders are ignored on decode.
type NotifyRequest struct {
	Command      string `json:"command,omitempty"` // e.g. "/spore" — routes to correct workspace config
	Platform     string `json:"platform"`          // "slack"
	WorkspaceID  string `json:"workspace_id"`      // e.g. "T03NE3GTY"
	EventType    string `json:"event_type"`        // ttl_warning, completion, etc.
	InstanceName string `json:"instance_name"`
	InstanceID   string `json:"instance_id"`
	Region       string `json:"region"`
	DNSName      string `json:"dns_name,omitempty"`
	Detail       string `json:"detail,omitempty"`
}

// handleNotify receives lifecycle events from spored and routes them to Slack.
// POST /notify — authentication via EC2 instance identity (no user credentials needed).
func handleNotify(ctx context.Context, cfg aws.Config, reg *Registry, request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	var nr NotifyRequest
	if err := json.Unmarshal([]byte(request.Body), &nr); err != nil {
		return errorResp(400, "Invalid request body"), nil
	}

	if nr.WorkspaceID == "" || nr.InstanceID == "" {
		return errorResp(400, "workspace_id and instance_id are required"), nil
	}

	// AuthZ (spore-host/spawn#2 audit, C2): only fan out to per-user DMs / SMS
	// when this instance is actually REGISTERED in the workspace. Without this,
	// anyone who learns an instance_id + workspace_id could DM registered users
	// and trigger platform-billed SMS for an instance that isn't theirs. The
	// channel WEBHOOK path is left ungated: the workspace owner opted in by
	// configuring the webhook, and it carries no per-user targeting or SMS cost.
	registered, err := reg.InstanceRegisteredInWorkspace(ctx, nr.Platform, nr.WorkspaceID, nr.InstanceID)
	if err != nil {
		logf("notify: registration check failed for %s in %s#%s: %v", nr.InstanceID, nr.Platform, nr.WorkspaceID, err)
		return errorResp(500, "registration check failed"), nil
	}

	// Authentication is the registry-membership gate above (a notification is
	// only delivered for an instance registered in the target workspace). The
	// former PKCS#7/embedded-cert identity check was log-only — it never rejected
	// anything and its embedded certs were unreliable across regions/rotations
	// (mirrors the dns-updater #294 retirement) — so it misrepresented the crypto
	// posture and has been removed (#374). Membership is the enforced control.

	msg := formatNotification(nr)

	// Look up workspace configs. When the command is known (e.g. "/spore"),
	// use the command-scoped key directly to avoid cross-app DM duplication.
	// Fall back to scanning all configs if no command is specified.
	var workspaces []WorkspaceConfig
	if nr.Command != "" {
		if ws, err := reg.getWorkspaceByKey(ctx, workspaceKey(nr.Platform, nr.WorkspaceID, nr.Command)); err == nil {
			workspaces = []WorkspaceConfig{*ws}
		}
	}
	if len(workspaces) == 0 {
		workspaces = reg.GetWorkspacesForPlatform(ctx, nr.Platform, nr.WorkspaceID)
	}
	if len(workspaces) == 0 {
		logf("notify: no workspaces found for %s#%s", nr.Platform, nr.WorkspaceID)
		return jsonOK(), nil
	}

	// Use a background context for outbound Slack calls — the request context
	// is cancelled as soon as handleNotify returns, killing in-flight HTTP calls.
	slackCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Discord: post a color-coded embed to the channel webhook (#2). Discord
	// uses its own embed payload rather than Slack's plain text/blocks; DM-by-bot
	// is a later addition (interactions phase), so webhook is the delivery path.
	if nr.Platform == "discord" {
		embed := buildDiscordEmbed(nr)
		for i := range workspaces {
			if ws := &workspaces[i]; ws.IncomingWebhookURL != "" {
				postDiscordWebhook(ws.IncomingWebhookURL, embed)
			}
		}
		return jsonOK(), nil
	}

	for i := range workspaces {
		ws := &workspaces[i]
		// Pattern A: channel webhook — ungated (workspace opted in; no per-user
		// targeting or SMS cost).
		if ws.IncomingWebhookURL != "" {
			postIncomingWebhook(ws.IncomingWebhookURL, msg)
		}
		// Pattern B: per-user DMs — only for a registered instance (C2).
		if registered {
			sendUserDMs(slackCtx, cfg, reg, ws, nr.InstanceID, msg)
		}
	}

	// Per-user DM/SMS fan-out (Teams + SMS) — gated on registration like Slack DMs.
	if registered {
		if nr.Platform == "slack" || nr.Platform == "" {
			sendTeamsDMs(slackCtx, reg, nil, nr.InstanceID, msg)
		}
		go sendUserSMS(context.Background(), reg, nr)
	} else {
		logf("notify: instance %s not registered in %s#%s — channel webhook only, skipping DM/SMS", nr.InstanceID, nr.Platform, nr.WorkspaceID)
	}

	return jsonOK(), nil
}

// postIncomingWebhook POSTs a message to a Slack incoming webhook URL.
func postIncomingWebhook(webhookURL, text string) {
	payload, _ := json.Marshal(map[string]string{"text": text})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", webhookURL, bytes.NewReader(payload))
	if err != nil {
		logf("incoming webhook request error: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		logf("incoming webhook call error: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		logf("incoming webhook returned %d", resp.StatusCode)
	}
}

// sendUserDMs sends DMs to each Slack user registered for this instance.
func sendUserDMs(ctx context.Context, cfg aws.Config, reg *Registry, ws *WorkspaceConfig, instanceID, text string) {
	if ws.BotToken == "" {
		return
	}

	// Query instance_id-index GSI for all registrations for this instance
	client := dynamodb.NewFromConfig(cfg)
	result, err := client.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(reg.registryTable),
		IndexName:              aws.String("instance_id-index"),
		KeyConditionExpression: aws.String("instance_id = :iid"),
		ExpressionAttributeValues: map[string]dynamodbtypes.AttributeValue{
			":iid": &dynamodbtypes.AttributeValueMemberS{Value: instanceID},
		},
	})
	if err != nil || len(result.Items) == 0 {
		return
	}

	// Get a fresh bot token (handles rotation if enabled)
	botToken := ws.BotToken

	for _, item := range result.Items {
		userKey, ok := item["user_key"].(*dynamodbtypes.AttributeValueMemberS)
		if !ok {
			continue
		}
		// user_key = "{platform}#{workspace}#{user_id}"
		parts := strings.SplitN(userKey.Value, "#", 3)
		if len(parts) != 3 {
			continue
		}
		userID := parts[2]

		// Send DM via chat.postMessage
		go postSlackDM(botToken, userID, text)
	}
}

// postSlackDM sends a direct message to a Slack user via chat.postMessage.
// Uses its own 8-second timeout context, deliberately not the caller's, so caller
// context cancellation doesn't abort the call.
func postSlackDM(botToken, userID, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	payload, _ := json.Marshal(map[string]string{
		"channel": userID, // Using user ID as channel opens a DM
		"text":    text,
	})
	req, err := http.NewRequestWithContext(ctx, "POST", "https://slack.com/api/chat.postMessage",
		bytes.NewReader(payload))
	if err != nil {
		logf("DM request error for %s: %v", userID, err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+botToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		logf("DM call error for %s: %v", userID, err)
		return
	}
	defer resp.Body.Close()
	var slackResp struct {
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
	}
	if body, err := io.ReadAll(resp.Body); err == nil {
		if jsonErr := json.Unmarshal(body, &slackResp); jsonErr == nil && !slackResp.OK {
			logf("DM to %s failed: %s", userID, slackResp.Error)
		}
	}
}

// detailEvents are the events whose Detail is an error or output tail that the
// user needs to see verbatim (why it failed), rendered as a code block on Slack
// and as a "Details" field on Discord. Events whose Detail is a short value
// woven into the sentence (ttl_warning's remaining time, region_vacated's
// region) are not listed.
var detailEvents = map[string]bool{
	"pre_stop_failed":  true, // hook error + output tail (#186)
	"pre_stop_timeout": true,
	"idle_stop_failed": true, // action + EC2 error, e.g. a one-time Spot instance (#558)
	"fsx_mount_failed": true, // "<fsx-id>: <mount error>"
	"fsx_dra_failed":   true, // "<fsx-id>: <association error>"
}

// formatNotification builds the Slack message text for a lifecycle event.
func formatNotification(nr NotifyRequest) string {
	name := nr.InstanceName
	if name == "" {
		name = nr.InstanceID
	}

	var icon, verb string
	switch nr.EventType {
	case "ttl_warning":
		icon, verb = "⏱️", fmt.Sprintf("*%s* terminates in %s", name, nr.Detail)
	case "ttl_expired":
		icon, verb = "🔴", fmt.Sprintf("*%s* has terminated — scheduled end time reached", name)
	case "idle_warning":
		icon, verb = "💤", fmt.Sprintf("*%s* will stop in %s — no activity detected", name, nr.Detail)
	case "idle_stopped":
		icon, verb = "⏹️", fmt.Sprintf("*%s* has stopped — idle timeout reached", name)
	case "idle_hibernated":
		icon, verb = "💤", fmt.Sprintf("*%s* has hibernated — idle timeout reached", name)
	case "idle_terminated": // legacy — kept for older spored versions
		icon, verb = "🔴", fmt.Sprintf("*%s* has terminated — idle timeout reached", name)
	case "completion":
		icon, verb = "✅", fmt.Sprintf("*%s* has completed", name)
	case "spot_interrupt":
		icon, verb = "⚠️", fmt.Sprintf("*%s* received a Spot interruption notice — %s", name, nr.Detail)
	case "pre_stop_start":
		icon, verb = "🔄", fmt.Sprintf("*%s* is running its shutdown task before terminating", name)
	case "pre_stop_failed":
		icon, verb = "🟠", fmt.Sprintf("*%s* shutdown task FAILED — output may NOT have been saved", name)
	case "pre_stop_timeout":
		icon, verb = "🟠", fmt.Sprintf("*%s* shutdown task TIMED OUT — output may be incomplete", name)
	case "idle_stop_failed":
		icon, verb = "🟠", fmt.Sprintf("*%s* could not be stopped at idle timeout — it is still running (and billing)", name)
	case "fsx_mount_failed":
		icon, verb = "🟠", fmt.Sprintf("*%s* could not mount its FSx for Lustre filesystem — the workload has no shared storage", name)
	case "fsx_dra_failed":
		icon, verb = "🟠", fmt.Sprintf("*%s* FSx data-repository link to S3 FAILED — imported data may be missing and results may not export", name)
	case "region_vacated":
		icon, verb = "🧹", fmt.Sprintf("*%s* was the last spawn-managed instance in %s — the region is now vacated", name, nr.Detail)
	default:
		icon, verb = "ℹ️", fmt.Sprintf("*%s*: %s", name, nr.EventType)
	}
	if detailEvents[nr.EventType] && nr.Detail != "" {
		verb += fmt.Sprintf("\n  ```%s```", nr.Detail)
	}

	msg := fmt.Sprintf("%s %s", icon, verb)
	if nr.DNSName != "" {
		msg += fmt.Sprintf("\n  URL: https://%s", nr.DNSName)
	}
	if nr.InstanceID != "" {
		msg += fmt.Sprintf("\n  AWS Instance ID: `%s`", nr.InstanceID)
	}
	if nr.Region != "" {
		msg += fmt.Sprintf("  Region: %s", nr.Region)
	}
	return msg
}

// sendUserSMS sends SMS notifications to users who have registered a phone number
// for the instance. It looks up registrations via the instance_id-index GSI, then
// for each user checks if a _phone record exists in the registry.
func sendUserSMS(ctx context.Context, reg *Registry, nr NotifyRequest) {
	project := strings.TrimPrefix(nr.Command, "/")
	if project == "" {
		project = "spore"
	}
	if twilioProjectNumber(project) == "" {
		return // Twilio not configured — skip silently
	}
	fromNumber := twilioProjectNumber(project)
	if fromNumber == "" {
		return
	}

	// Query instance registrations
	result, err := reg.client.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(reg.registryTable),
		IndexName:              aws.String("instance_id-index"),
		KeyConditionExpression: aws.String("instance_id = :iid"),
		ExpressionAttributeValues: map[string]dynamodbtypes.AttributeValue{
			":iid": &dynamodbtypes.AttributeValueMemberS{Value: nr.InstanceID},
		},
	})
	if err != nil || len(result.Items) == 0 {
		return
	}

	// Build the SMS message once
	extra := map[string]string{
		"remaining":     "5 minutes",
		"idle_duration": "25m",
		"cost":          "$0.00",
	}
	if nr.Detail != "" {
		extra["remaining"] = nr.Detail
		extra["idle_duration"] = nr.Detail
		extra["detail"] = nr.Detail // the error for detailEvents (pre_stop_*, idle_stop_failed, fsx_*), the region for region_vacated
	}
	msgText, options := twilioMessage(nr.InstanceName, nr.EventType, extra)

	smsCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	seen := map[string]bool{}
	for _, item := range result.Items {
		ukAttr, ok := item["user_key"].(*dynamodbtypes.AttributeValueMemberS)
		if !ok {
			continue
		}
		userKey := ukAttr.Value
		if seen[userKey] {
			continue
		}
		seen[userKey] = true

		// Look up _phone record for this user
		phoneResult, err := reg.client.GetItem(smsCtx, &dynamodb.GetItemInput{
			TableName: aws.String(reg.registryTable),
			Key: map[string]dynamodbtypes.AttributeValue{
				"user_key": &dynamodbtypes.AttributeValueMemberS{Value: userKey},
				"nickname": &dynamodbtypes.AttributeValueMemberS{Value: "_phone"},
			},
		})
		if err != nil || phoneResult.Item == nil {
			continue
		}
		phoneAttr, ok := phoneResult.Item["phone"].(*dynamodbtypes.AttributeValueMemberS)
		if !ok || phoneAttr.Value == "" {
			continue
		}
		toPhone := phoneAttr.Value

		// Store pending notification so the reply can be matched
		if len(options) > 0 {
			_ = twilioStorePending(smsCtx, fromNumber, toPhone, project, nr.InstanceID, nr.Region, nr.EventType, options)
		}

		// Send the SMS
		go func(phone string) {
			if err := twilioSend(smsCtx, project, phone, msgText); err != nil {
				logf("SMS to %s failed: %v", phone, err)
			}
		}(toPhone)
	}
}

func jsonOK() events.APIGatewayProxyResponse {
	return events.APIGatewayProxyResponse{
		StatusCode: 200,
		Headers:    map[string]string{"Content-Type": "application/json"},
		Body:       `{"ok":true}`,
	}
}
