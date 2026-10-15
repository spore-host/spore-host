package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
)

// handleWebhook is Phase 1: verify signature, ACK immediately, kick off async execution.
func handleWebhook(ctx context.Context, cfg aws.Config, reg *Registry, request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	path := strings.ToLower(request.Path)

	var sc *SlashCommand
	var platform string
	var err error

	// Discord interactions are their own flow: a single app-wide endpoint, Ed25519
	// verification, a PING/PONG handshake, and a synchronous DEFERRED ack with the
	// real result delivered via follow-up. Handle it before the Slack/Teams path (#2).
	if strings.HasSuffix(path, "/discord") {
		return handleDiscordWebhook(ctx, cfg, reg, request)
	}

	// Handle Slack URL verification challenge before any signature checking.
	// Slack sends this once when a slash command endpoint is configured.
	if strings.HasSuffix(path, "/slack") {
		if challenge := extractURLVerificationChallenge(request.Body); challenge != "" {
			return jsonResp(200, fmt.Sprintf(`{"challenge":%q}`, challenge)), nil
		}
	}

	switch {
	case strings.HasSuffix(path, "/slack"):
		platform = "slack"
		sc, err = handleSlackWebhook(ctx, reg, request)
	case strings.HasSuffix(path, "/teams"):
		platform = "teams"
		sc, err = handleTeamsWebhook(ctx, reg, request)
	default:
		return errorResp(404, "not found"), nil
	}

	if err != nil {
		logf("webhook error (%s): %v", platform, err)
		return errorResp(401, err.Error()), nil
	}
	if sc == nil {
		// URL verification challenge already handled
		return jsonResp(200, `{"ok":true}`), nil
	}

	// Parse command, nickname, and optional arg from the text
	command, nickname, arg := parseCommandText(sc.Text)
	if command == "" {
		command = "help"
	}

	// Build action payload for async Phase 2
	action := &BotAction{
		Platform:     platform,
		WorkspaceID:  sc.WorkspaceID,
		UserID:       sc.UserID,
		ResponseURL:  sc.ResponseURL,
		Command:      command,
		Nickname:     nickname,
		Arg:          arg,
		SlashCommand: sc.Command, // e.g. "/spore" or "/prism" — used in help text
	}

	// Teams (Bot Framework): return the ack inline in the HTTP 200 body. Every
	// command but help runs in Phase 2, like Slack's: even "list" makes EC2
	// calls, so none is short enough to promise to finish before returning.
	if platform == "teams" {
		botID := os.Getenv("TEAMS_APP_ID")
		teamsText := helpText(action.slashCmd())
		if command != "help" {
			teamsText = ackOrFailure(queueAction(ctx, action), command, nickname)
		}
		logf("teams inline response len=%d", len(teamsText))
		resp := fmt.Sprintf(`{"type":"message","from":{"id":%q,"name":"spore-bot"},"text":%q}`, botID, teamsText)
		return jsonResp(200, resp), nil
	}

	// Slack: queue Phase 2 and ACK within the 3-second window.
	return jsonResp(200, fmt.Sprintf(`{"text":%q}`, ackOrFailure(queueAction(ctx, action), command, nickname))), nil
}

// dispatchFailedText is the reply when Phase 2 could not be queued: the
// command did not run, and the user is told so rather than shown an ack.
const dispatchFailedText = "❌ spore-bot couldn't queue that command, so it did not run. Please try again."

// dispatchAuditBudget bounds the audit write for a dispatch failure, which is
// on the platform's ack path (Slack and Discord allow 3 seconds).
const dispatchAuditBudget = time.Second

// ackOrFailure is the reply for a command: its ack if it was queued, else
// dispatchFailedText.
func ackOrFailure(queued bool, command, nickname string) string {
	if queued {
		return ackMessage(command, nickname)
	}
	return dispatchFailedText
}

// queueAction queues action for Phase 2 (an async self-invocation, which
// Lambda queues durably and retries) and reports whether it was queued. If it
// was not, it records the failure in the audit log.
//
// It used to fall back to running the action in a goroutine (#572). Lambda
// freezes the environment once the handler returns, so that goroutine was
// suspended until the next invocation or lost, while the user had been told
// the command was accepted. Running the action inline instead would blow the
// 3-second ack window that the self-invocation exists to meet.
func queueAction(ctx context.Context, action *BotAction) bool {
	err := invokeAsync(ctx, action)
	if err == nil {
		return true
	}
	logf("async invoke failed (%s %s): %v", action.Platform, action.Command, err)
	if auditor != nil {
		auditor.logWithin(ctx, dispatchAuditBudget, newAuditEvent(action, AuditResultError, "not queued: "+err.Error()))
	}
	return false
}

// handleDiscordWebhook verifies a Discord interaction (Ed25519), answers the
// PING handshake, and for a slash command ACKs with a DEFERRED response while
// the real result is computed async and delivered via the interaction follow-up
// webhook (#2). Discord's 3-second deadline is met by the deferred ack.
func handleDiscordWebhook(ctx context.Context, cfg aws.Config, reg *Registry, request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	sig := headerLookup(request.Headers, "X-Signature-Ed25519")
	ts := headerLookup(request.Headers, "X-Signature-Timestamp")
	body := []byte(request.Body)

	// Verify against the APPLICATION public key — Discord signs every interaction
	// with the app's single Ed25519 key (one per application, not per guild), and
	// the endpoint-verification PING carries no guild at all. So verification must
	// use the app key (DISCORD_PUBLIC_KEY) independent of guild; the per-guild
	// workspace lookup happens later, only to authorize the command (#2).
	if err := verifyDiscordSignature(discordPublicKey, sig, ts, body); err != nil {
		logf("discord signature verification failed: %v", err)
		return errorResp(401, "invalid request signature"), nil
	}

	var it discordInteraction
	if err := json.Unmarshal(body, &it); err != nil {
		return errorResp(400, "invalid interaction body"), nil
	}

	// PING → PONG handshake (Discord verifies the endpoint this way). This must
	// work with no workspace registered — it's an app-level health check.
	if it.Type == discordInteractionPing {
		return jsonResp(200, fmt.Sprintf(`{"type":%d}`, discordResponsePong)), nil
	}

	if it.Type != discordInteractionApplicationCommand {
		// Components/autocomplete/etc. aren't used yet — ack harmlessly.
		return jsonResp(200, fmt.Sprintf(`{"type":%d}`, discordResponsePong)), nil
	}

	// Authorize: the guild must be a registered workspace before we act on a
	// command (verification above already proved the request is genuinely Discord).
	if ws, err := reg.GetWorkspace(ctx, "discord", it.GuildID); err != nil || ws == nil {
		logf("discord: command from unregistered guild %s", it.GuildID)
		return jsonResp(200, `{"type":4,"data":{"content":"This server isn't set up with spore-bot yet. An admin can run: spawn notify workspace-add --platform discord --workspace-id <guild> --public-key <key>"}}`), nil
	}

	// Map the slash command. We model `/spore <command> <nickname> [arg]` as
	// subcommand options so it mirrors the Slack/Teams text parse.
	command, nickname, arg := discordCommand(&it)
	action := &BotAction{
		Platform:     "discord",
		WorkspaceID:  it.GuildID,
		UserID:       it.discordUserID(),
		ResponseURL:  discordFollowupURL(it.AppID, it.Token),
		Command:      command,
		Nickname:     nickname,
		Arg:          arg,
		SlashCommand: "/" + it.Data.Name,
	}

	// Kick off the real work async; the deferred ack below buys >3s.
	if !queueAction(ctx, action) {
		return jsonResp(200, fmt.Sprintf(`{"type":4,"data":{"content":%q}}`, dispatchFailedText)), nil
	}
	// DEFERRED ack: shows "spore-bot is thinking…"; executeAction edits it with
	// the result via postDiscordResponse.
	return jsonResp(200, fmt.Sprintf(`{"type":%d}`, discordResponseDeferredChannelMsg)), nil
}

// headerLookup returns a header value, tolerating canonical and lowercased keys
// (API Gateway / Function URL casing varies).
func headerLookup(headers map[string]string, key string) string {
	if v := headers[key]; v != "" {
		return v
	}
	return headers[strings.ToLower(key)]
}

// handleSlackWebhook verifies the Slack signature and parses the slash command.
func handleSlackWebhook(ctx context.Context, reg *Registry, request events.APIGatewayProxyRequest) (*SlashCommand, error) {
	ts := request.Headers["X-Slack-Request-Timestamp"]
	if ts == "" {
		ts = request.Headers["x-slack-request-timestamp"]
	}
	sig := request.Headers["X-Slack-Signature"]
	if sig == "" {
		sig = request.Headers["x-slack-signature"]
	}
	if ts == "" || sig == "" {
		return nil, fmt.Errorf("missing Slack signature headers")
	}

	sc, err := parseSlackCommand(request.Body)
	if err != nil {
		return nil, fmt.Errorf("parse command: %w", err)
	}

	// Slack does not include X-Slack-App-ID in slash command webhooks.
	// Use the slash command name (/spore, /prism) as discriminator when multiple
	// apps share a workspace, falling back to the legacy key.
	appID := request.Headers["X-Slack-App-ID"]
	if appID == "" {
		appID = request.Headers["x-slack-app-id"]
	}
	logf("slack webhook: team=%s command=%s app_id=%q", sc.WorkspaceID, sc.Command, appID)
	ws, err := reg.GetWorkspaceForSlash(ctx, "slack", sc.WorkspaceID, sc.Command, appID)
	if err != nil {
		return nil, fmt.Errorf("workspace not found: %w", err)
	}

	// Slack's signing secret is app-level, not per-workspace, so OAuth-installed
	// workspaces store none (oauth.go). Fall back to the hosted app's app-level
	// secret from the environment; the per-workspace value (admin-registered /
	// self-hosted) takes precedence. verifySlackSignature fails closed if both
	// are empty (spore-host#373).
	signingSecret := ws.SigningSecret
	if signingSecret == "" {
		signingSecret = os.Getenv("SLACK_SIGNING_SECRET")
	}
	if err := verifySlackSignature(signingSecret, ts, request.Body, sig); err != nil {
		return nil, fmt.Errorf("signature verification failed: %w", err)
	}

	// Channel restriction: if the workspace has an allowed-channels list, enforce it.
	if !IsChannelAllowed(ws, sc.ChannelID) {
		return nil, fmt.Errorf("commands are only accepted from designated channels in this workspace")
	}

	return sc, nil
}

// handleTeamsWebhook handles Bot Framework activities and outgoing webhooks.
// Bot Framework (Azure Bot / Test in Web Chat): Authorization: Bearer <jwt>
// Outgoing webhooks (direct Teams config):      Authorization: HMAC <base64>
func handleTeamsWebhook(ctx context.Context, reg *Registry, request events.APIGatewayProxyRequest) (*SlashCommand, error) {
	authHeader := request.Headers["Authorization"]
	if authHeader == "" {
		authHeader = request.Headers["authorization"]
	}

	// Parse activity to get workspace (tenant) ID
	sc, _, err := parseTeamsActivity(request.Body)
	if err != nil {
		return nil, fmt.Errorf("parse Teams activity: %w", err)
	}

	isBotFramework := strings.HasPrefix(authHeader, "Bearer ")

	if isBotFramework {
		// Bot Framework JWT — issued by Microsoft for our bot. Fully validate the
		// token (RS256 signature against Microsoft's JWKS, issuer, audience==App ID,
		// expiry) before trusting the activity. The public Function URL means an
		// unverified Bearer token is a forge-an-activity hole (spore-host#372).
		appID := os.Getenv("TEAMS_APP_ID")
		if appID == "" {
			return nil, fmt.Errorf("TEAMS_APP_ID not configured")
		}
		if err := verifyTeamsJWT(ctx, authHeader, appID); err != nil {
			//lint:ignore ST1005 "Bot Framework" is a proper noun; lowercasing would misspell it, and rewording would change error text callers see (#562)
			return nil, fmt.Errorf("Bot Framework token verification failed: %w", err)
		}
		// Workspace lookup is optional for Bot Framework — tenant may not have signing secret
		_, _ = reg.GetWorkspace(ctx, "teams", sc.WorkspaceID) // best-effort
	} else {
		// Outgoing webhook — verify HMAC signature
		ws, err := reg.GetWorkspace(ctx, "teams", sc.WorkspaceID)
		if err != nil {
			return nil, fmt.Errorf("workspace not found: %w", err)
		}
		if err := verifyTeamsSignature(ws.SigningSecret, request.Body, authHeader); err != nil {
			return nil, fmt.Errorf("signature verification failed: %w", err)
		}
	}

	// Store conversation reference for proactive messaging
	var activity TeamsActivity
	if jsonErr := json.Unmarshal([]byte(request.Body), &activity); jsonErr == nil {
		userKey := "teams#" + sc.WorkspaceID + "#" + sc.UserID
		// Stored before returning, not from a goroutine (#572).
		rctx, cancel := withinDeadline(ctx, teamsRefWriteBudget)
		storeTeamsConversationRef(rctx, reg, userKey, activity)
		cancel()
	}

	return sc, nil
}

// teamsRefWriteBudget bounds storing a Teams conversation reference, which is
// on the ack path (Bot Framework allows 15 seconds).
const teamsRefWriteBudget = 2 * time.Second

// handleAsyncAction is Phase 2: execute the EC2 op and post result to response_url.
func handleAsyncAction(ctx context.Context, cfg aws.Config, reg *Registry, payload []byte) error {
	var action BotAction
	if err := json.Unmarshal(payload, &action); err != nil {
		return fmt.Errorf("unmarshal action: %w", err)
	}

	// Commands that manage their own target or need no registration
	selfContained := map[string]bool{
		"help": true, "list": true, "connect": true,
		"notify": true, "unnotify": true,
	}
	if !selfContained[action.Command] {
		registration, ambiguousMsg, err := resolveRegistration(ctx, reg, &action)
		if err != nil {
			postResponse(action.Platform, action.ResponseURL, "❌ "+err.Error())
			return nil
		}
		if ambiguousMsg != "" {
			postResponse(action.Platform, action.ResponseURL, ambiguousMsg)
			return nil
		}
		action.Registration = registration
	}

	executeAction(ctx, cfg, reg, &action)
	return nil
}

// splitSlashPrefix removes a leading slash-command name from text, so that
// "/spore list" and "list" both yield "list", the text Slack delivers after its
// own command. It returns the prefix, lowercased ("" if there was none), and
// the rest with runs of whitespace collapsed to single spaces. "/spore" and
// BOT_SLASH_COMMAND are always accepted; names adds more (e.g. Discord's
// registered command). Any other leading "/word" is left in place.
func splitSlashPrefix(text string, names ...string) (prefix, rest string) {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return "", ""
	}
	accepted := append([]string{"/spore", getEnv("BOT_SLASH_COMMAND", "/spore")}, names...)
	for _, name := range accepted {
		if name != "" && strings.EqualFold(fields[0], name) {
			return strings.ToLower(fields[0]), strings.Join(fields[1:], " ")
		}
	}
	return "", strings.Join(fields, " ")
}

// parseCommandText splits "extend rstudio 2h" into ("extend", "rstudio", "2h").
func parseCommandText(text string) (command, nickname, arg string) {
	parts := strings.Fields(strings.ToLower(strings.TrimSpace(text)))
	if len(parts) == 0 {
		return "help", "", ""
	}
	command = parts[0]
	if len(parts) > 1 {
		nickname = parts[1]
	}
	if len(parts) > 2 {
		arg = parts[2]
	}
	return
}

// ackMessage returns the immediate ACK text shown while the op runs.
func ackMessage(command, nickname string) string {
	target := ""
	if nickname != "" {
		target = " *" + nickname + "*"
	}
	switch command {
	case "start":
		return "▶️ Starting" + target + "..."
	case "stop":
		return "⏹️ Stopping" + target + "..."
	case "hibernate":
		return "💤 Hibernating" + target + "..."
	case "status", "url":
		return "🔍 Checking" + target + "..."
	case "list":
		return "📋 Fetching your instances..."
	case "connect":
		return "🔑 Generating your connect code — check your DMs..."
	case "extend":
		if nickname != "" {
			return "⏱️ Extending TTL for *" + nickname + "*..."
		}
		return "⏱️ Extending TTL..."
	case "idle":
		if nickname != "" {
			return "💤 Updating idle timeout for *" + nickname + "*..."
		}
		return "💤 Updating idle timeout..."
	case "notify":
		if nickname != "" {
			return "🔔 Subscribing to notifications for *" + nickname + "*..."
		}
		return "🔔 Setting up notifications..."
	case "unnotify":
		if nickname != "" {
			return "🔕 Removing notifications for *" + nickname + "*..."
		}
		return "🔕 Removing notification subscription..."
	default:
		return "⏳ On it..."
	}
}

func jsonResp(status int, body string) events.APIGatewayProxyResponse {
	return events.APIGatewayProxyResponse{
		StatusCode: status,
		Headers:    map[string]string{"Content-Type": "application/json"},
		Body:       body,
	}
}

func errorResp(status int, msg string) events.APIGatewayProxyResponse {
	return jsonResp(status, fmt.Sprintf(`{"error":%q}`, msg))
}
