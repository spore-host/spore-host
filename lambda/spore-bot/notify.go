package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
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
	// OriginalInstanceID is sent only with spot_replacement_retired (spawn#995,
	// spawn#1007): the instance a Spot replacement was launched for. See
	// notifyTargetInstance.
	OriginalInstanceID string `json:"original_instance_id,omitempty"`
}

// instanceIDRE matches an EC2 instance id.
var instanceIDRE = regexp.MustCompile(`^i-[0-9a-f]{8,17}$`)

// notifyTargetInstance is the instance whose registrations a notification is
// delivered to (per-user Slack and Teams DMs, SMS).
//
// Normally that is the sender, nr.InstanceID. The exception is
// spot_replacement_retired. It comes from a replacement that EC2 launched from
// a leaked persistent Spot request after the original was terminated outside
// spawn. The replacement has a new instance id that nobody registered, so gating
// on it would drop every DM and SMS and leave only channel webhooks. For that
// event the target is the original, named in original_instance_id.
//
// This grants nothing new. The registration gate (C2 in handleNotify) is an
// authorization check on ids, not an authentication of the sender: a caller
// that knows a registered instance id can already put it in instance_id and
// reach the same users. Accepting the original's id from this one field, for
// this one event, therefore widens no one's reach. It is limited to that event
// and to a well-formed id that differs from the sender's, so no other event's
// routing changes.
func notifyTargetInstance(nr NotifyRequest) string {
	if nr.EventType == "spot_replacement_retired" &&
		instanceIDRE.MatchString(nr.OriginalInstanceID) && nr.OriginalInstanceID != nr.InstanceID {
		return nr.OriginalInstanceID
	}
	return nr.InstanceID
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
	//
	// The registrations checked, and DMed, are notifyTargetInstance's: the
	// sender's own, except for a Spot replacement, which names its original.
	target := notifyTargetInstance(nr)
	registered, err := reg.InstanceRegisteredInWorkspace(ctx, nr.Platform, nr.WorkspaceID, target)
	if err != nil {
		logf("notify: registration check failed for %s in %s#%s: %v", target, nr.Platform, nr.WorkspaceID, err)
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

	// Every delivery below completes before handleNotify returns (#566). Lambda
	// freezes the execution environment once the handler returns, so a send
	// still running in a goroutine at that point is suspended until the next
	// invocation of this environment, or lost if there is none. deliveryContext
	// bounds the whole fan-out under the Lambda deadline.
	dctx, cancel := deliveryContext(ctx)
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

	// The per-user fan-outs run concurrently; each one waits for its own sends.
	var wg sync.WaitGroup
	for i := range workspaces {
		ws := &workspaces[i]
		// Pattern A: channel webhook — ungated (workspace opted in; no per-user
		// targeting or SMS cost).
		if ws.IncomingWebhookURL != "" {
			postIncomingWebhook(ws.IncomingWebhookURL, msg)
		}
		// Pattern B: per-user DMs — only for a registered instance (C2).
		if registered {
			wg.Go(func() { sendUserDMs(dctx, cfg, reg, ws, target, msg) })
		}
	}

	// Per-user DM/SMS fan-out (Teams + SMS) — gated on registration like Slack DMs.
	if registered {
		if nr.Platform == "slack" || nr.Platform == "" {
			wg.Go(func() { sendTeamsDMs(dctx, reg, nil, target, msg) })
		}
		wg.Go(func() { sendUserSMS(dctx, reg, nr, target) })
	} else {
		logf("notify: instance %s not registered in %s#%s — channel webhook only, skipping DM/SMS", target, nr.Platform, nr.WorkspaceID)
	}
	wg.Wait()

	return jsonOK(), nil
}

// notifyDeliveryBudget bounds a /notify fan-out (DynamoDB lookups plus every
// Slack/Teams DM and SMS, run concurrently). Each send also keeps its own
// per-call timeout. The function's timeout is 120s (infra/tofu/spore-bot).
const notifyDeliveryBudget = 25 * time.Second

// lambdaDeadlineMargin is left between the end of the fan-out and the Lambda
// deadline, for the response and logging.
const lambdaDeadlineMargin = 2 * time.Second

// deliveryContext returns the context for a /notify fan-out: ctx (the
// invocation's, alive until the handler returns) bounded by
// notifyDeliveryBudget, and by ctx's deadline less lambdaDeadlineMargin.
func deliveryContext(ctx context.Context) (context.Context, context.CancelFunc) {
	budget := notifyDeliveryBudget
	if dl, ok := ctx.Deadline(); ok {
		if left := time.Until(dl) - lambdaDeadlineMargin; left < budget {
			budget = left
		}
	}
	return context.WithTimeout(ctx, budget)
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

// sendUserDMs sends DMs to each Slack user registered for this instance,
// concurrently, and returns when every send has finished.
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

	var wg sync.WaitGroup
	defer wg.Wait()
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
		wg.Go(func() { postSlackDM(ctx, botToken, userID, text) })
	}
}

// dmSendTimeout bounds one Slack or Teams DM call.
const dmSendTimeout = 8 * time.Second

// postSlackDM sends a direct message to a Slack user via chat.postMessage,
// bounded by ctx and dmSendTimeout. The caller waits for it (#566).
func postSlackDM(ctx context.Context, botToken, userID, text string) {
	ctx, cancel := context.WithTimeout(ctx, dmSendTimeout)
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
	"pre_stop_failed":        true, // hook error + output tail (#186)
	"pre_stop_timeout":       true,
	"idle_stop_failed":       true, // action + EC2 error, e.g. a one-time Spot instance (#558)
	"completion_stop_failed": true, // --on-complete action + EC2 error (spawn#978, #563)
	"fsx_mount_failed":       true, // "<fsx-id>: <mount error>"
	"fsx_dra_failed":         true, // "<fsx-id>: <association error>"
	// "replacement of <orig> launched by leaked Spot request <sir>; ..." names
	// the request, which the user needs if the retirement fails.
	"spot_replacement_retired": true,
}

// replacementSubject names the instance a spot_replacement_retired message is
// about: the original. spored reports the original's DNS name when it had one,
// and otherwise its own (the replacement's) id, which would read as though the
// replacement had been replaced.
func replacementSubject(nr NotifyRequest) string {
	if nr.InstanceName != "" && nr.InstanceName != nr.InstanceID {
		return nr.InstanceName
	}
	if nr.OriginalInstanceID != "" {
		return nr.OriginalInstanceID
	}
	if nr.InstanceName != "" {
		return nr.InstanceName
	}
	return nr.InstanceID
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
	case "completion_stop_failed":
		icon, verb = "🟠", fmt.Sprintf("*%s* finished its job but could not be stopped — it is still running (and billing)", name)
	case "fsx_mount_failed":
		icon, verb = "🟠", fmt.Sprintf("*%s* could not mount its FSx for Lustre filesystem — the workload has no shared storage", name)
	case "fsx_dra_failed":
		icon, verb = "🟠", fmt.Sprintf("*%s* FSx data-repository link to S3 FAILED — imported data may be missing and results may not export", name)
	case "region_vacated":
		icon, verb = "🧹", fmt.Sprintf("*%s* was the last spawn-managed instance in %s — the region is now vacated", name, nr.Detail)
	case "spot_replacement_retired":
		icon, verb = "♻️", fmt.Sprintf("*%s* was terminated, but its persistent Spot request was left open and launched a replacement instance (no spawn tags, no TTL). The replacement is cancelling the request and shutting itself down", replacementSubject(nr))
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
// for each user checks if a _phone record exists in the registry. target is
// the instance whose registrations are used (notifyTargetInstance). The sends
// run concurrently, and it returns when every send has finished.
func sendUserSMS(ctx context.Context, reg *Registry, nr NotifyRequest, target string) {
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
			":iid": &dynamodbtypes.AttributeValueMemberS{Value: target},
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
		extra["detail"] = nr.Detail // the error for detailEvents (pre_stop_*, idle_stop_failed, completion_stop_failed, fsx_*), the region for region_vacated
	}
	name := nr.InstanceName
	if nr.EventType == "spot_replacement_retired" {
		name = replacementSubject(nr)
	}
	msgText, options := twilioMessage(name, nr.EventType, extra)

	var wg sync.WaitGroup
	defer wg.Wait()
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
		phoneResult, err := reg.client.GetItem(ctx, &dynamodb.GetItemInput{
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
			_ = twilioStorePending(ctx, fromNumber, toPhone, project, nr.InstanceID, nr.Region, nr.EventType, options)
		}

		// Send the SMS. Its context is ctx, which outlives this loop, bounded per
		// send. (It used to be a context cancelled by a defer as soon as the loop
		// ended, usually before Twilio answered: #566.)
		wg.Go(func() {
			sendCtx, cancel := context.WithTimeout(ctx, smsSendTimeout)
			defer cancel()
			if err := twilioSend(sendCtx, project, toPhone, msgText); err != nil {
				logf("SMS to %s failed: %v", toPhone, err)
			}
		})
	}
}

// smsSendTimeout bounds one Twilio send.
const smsSendTimeout = 10 * time.Second

func jsonOK() events.APIGatewayProxyResponse {
	return events.APIGatewayProxyResponse{
		StatusCode: 200,
		Headers:    map[string]string{"Content-Type": "application/json"},
		Body:       `{"ok":true}`,
	}
}
