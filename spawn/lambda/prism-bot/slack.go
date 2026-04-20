package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// SlashCommand represents a parsed Slack slash command payload.
type SlashCommand struct {
	Command     string
	Text        string
	UserID      string
	WorkspaceID string
	ResponseURL string
	TriggerID   string
}

// extractURLVerificationChallenge detects Slack's one-time endpoint verification
// request and returns the challenge string if present, otherwise empty string.
// Slack sends {"type":"url_verification","challenge":"..."} as JSON when you
// configure a new slash command endpoint — no HMAC required for this event.
func extractURLVerificationChallenge(body string) string {
	if !strings.HasPrefix(strings.TrimSpace(body), "{") {
		return ""
	}
	var v struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		return ""
	}
	if v.Type == "url_verification" {
		return v.Challenge
	}
	return ""
}

// parseSlackCommand parses a URL-encoded Slack slash command body.
func parseSlackCommand(body string) (*SlashCommand, error) {
	vals, err := url.ParseQuery(body)
	if err != nil {
		return nil, fmt.Errorf("parse body: %w", err)
	}
	return &SlashCommand{
		Command:     vals.Get("command"),
		Text:        strings.TrimSpace(vals.Get("text")),
		UserID:      vals.Get("user_id"),
		WorkspaceID: vals.Get("team_id"),
		ResponseURL: vals.Get("response_url"),
		TriggerID:   vals.Get("trigger_id"),
	}, nil
}

// verifySlackSignature validates the X-Slack-Signature header.
// Uses HMAC-SHA256 with the workspace signing secret.
// Rejects requests older than 5 minutes to prevent replay attacks.
func verifySlackSignature(signingSecret, timestamp, body, sig string) error {
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid timestamp: %w", err)
	}
	if age := time.Now().Unix() - ts; age > 300 || age < -60 {
		return fmt.Errorf("request timestamp too old or in future (%ds)", age)
	}

	baseStr := "v0:" + timestamp + ":" + body
	mac := hmac.New(sha256.New, []byte(signingSecret))
	mac.Write([]byte(baseStr))
	expected := "v0=" + hex.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(expected), []byte(sig)) {
		return fmt.Errorf("signature mismatch")
	}
	return nil
}

// SlackMessage is the payload sent back to Slack via response_url.
type SlackMessage struct {
	ResponseType string `json:"response_type"` // "in_channel" or "ephemeral"
	Text         string `json:"text"`
}

// postSlackResponse sends a delayed response to Slack's response_url.
func postSlackResponse(responseURL, text string, inChannel bool) error {
	msgType := "ephemeral"
	if inChannel {
		msgType = "in_channel"
	}
	msg := SlackMessage{ResponseType: msgType, Text: text}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal response: %w", err)
	}
	return httpPost(responseURL, "application/json", data)
}

// formatInstanceStatus formats a status response for Slack.
func formatSlackStatus(nickname, instanceID, state, ip, dnsName string) string {
	icon := "🟡"
	switch state {
	case "running":
		icon = "🟢"
	case "stopped", "stopping":
		icon = "🔴"
	case "hibernated":
		icon = "💤"
	}

	lines := []string{
		fmt.Sprintf("%s *%s* (`%s`) — %s", icon, nickname, instanceID, state),
	}
	if ip != "" {
		lines = append(lines, fmt.Sprintf("  IP: `%s`", ip))
	}
	if dnsName != "" {
		lines = append(lines, fmt.Sprintf("  URL: https://%s", dnsName))
	}
	return strings.Join(lines, "\n")
}
