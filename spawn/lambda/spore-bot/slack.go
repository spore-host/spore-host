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
	ChannelID   string // used for channel restriction checks
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
		ChannelID:   vals.Get("channel_id"),
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

// InstanceStatus holds all display data for a status card.
type InstanceStatus struct {
	Nickname     string // user-facing name
	InstanceID   string // i-...
	State        string // running, stopped, stopping, hibernated, pending
	InstanceType string // t3.small, g7e.xlarge, etc.
	AZ           string // us-east-1a
	IP           string // public IP
	DNSName      string // spore-bot-test.5k0zfnmq.spore.host
	LaunchTime   string // RFC3339
	TTL          string // "4h"
	IdleTimeout  string // "1h"
}

// formatSlackStatus formats a rich status card for Slack.
func formatSlackStatus(s InstanceStatus) string {
	icon := "🟡"
	stateLabel := s.State
	switch s.State {
	case "running":
		icon = "🟢"
		stateLabel = "Running"
	case "stopped":
		icon = "🔴"
		stateLabel = "Stopped"
	case "hibernated":
		icon = "💤"
		stateLabel = "Hibernated (RAM saved)"
	case "stopping":
		icon = "🔴"
		stateLabel = "Stopping..."
	case "pending":
		icon = "🟡"
		stateLabel = "Starting..."
	case "shutting-down":
		icon = "🔴"
		stateLabel = "Shutting down..."
	case "terminated":
		icon = "⚫"
		stateLabel = "Terminated"
	}
	// Hibernation is reported as "stopped" by EC2 but spored tags the instance
	// — we don't distinguish here; user sees "stopped" which is accurate

	lines := []string{
		fmt.Sprintf("%s *%s* — %s", icon, s.Nickname, stateLabel),
		"",
	}

	if s.InstanceType != "" {
		lines = append(lines, fmt.Sprintf("  *AWS Instance Type:*  %s", s.InstanceType))
	}
	if s.AZ != "" {
		lines = append(lines, fmt.Sprintf("  *AWS Region:*         %s", s.AZ))
	}
	if s.IP != "" {
		lines = append(lines, fmt.Sprintf("  *IP Address:*         `%s`", s.IP))
	}
	if s.DNSName != "" {
		lines = append(lines, fmt.Sprintf("  *URL:*                https://%s", s.DNSName))
	}
	if s.LaunchTime != "" {
		if t, err := time.Parse(time.RFC3339, s.LaunchTime); err == nil {
			elapsed := formatDuration(time.Since(t))
			lines = append(lines, fmt.Sprintf("  *Launched:*           %s (%s ago)", t.UTC().Format("2 Jan 15:04 UTC"), elapsed))
		}
	}
	if s.TTL != "" {
		lines = append(lines, fmt.Sprintf("  *Auto-terminate:*     after %s from launch", s.TTL))
	}
	if s.IdleTimeout != "" {
		lines = append(lines, fmt.Sprintf("  *Idle timeout:*       after %s idle", s.IdleTimeout))
	}
	lines = append(lines, fmt.Sprintf("  *AWS Instance ID:*    `%s`", s.InstanceID))

	return strings.Join(lines, "\n")
}

// formatDuration formats a duration as "2h 15m" or "45m" etc.
func formatDuration(d time.Duration) string {
	d = d.Round(time.Minute)
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	if h > 0 && m > 0 {
		return fmt.Sprintf("%dh %dm", h, m)
	}
	if h > 0 {
		return fmt.Sprintf("%dh", h)
	}
	return fmt.Sprintf("%dm", m)
}
