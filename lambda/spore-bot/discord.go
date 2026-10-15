package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Discord embed colors (decimal RGB), keyed by event severity (#2).
const (
	discordColorGreen  = 0x2ECC71 // completion / healthy
	discordColorYellow = 0xF1C40F // warnings (ttl/idle warn, spot interrupt)
	discordColorRed    = 0xE74C3C // terminated / stopped
	discordColorBlue   = 0x3498DB // informational / in-progress
)

// discordEmbed is the subset of Discord's embed object we populate.
type discordEmbed struct {
	Title       string              `json:"title,omitempty"`
	Description string              `json:"description,omitempty"`
	Color       int                 `json:"color,omitempty"`
	URL         string              `json:"url,omitempty"`
	Fields      []discordEmbedField `json:"fields,omitempty"`
	Timestamp   string              `json:"timestamp,omitempty"`
}

type discordEmbedField struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Inline bool   `json:"inline"`
}

// buildDiscordEmbed turns a lifecycle notification into a color-coded Discord
// embed: title summarizes the event, fields carry instance/region/URL (#2).
func buildDiscordEmbed(nr NotifyRequest) discordEmbed {
	name := nr.InstanceName
	if name == "" {
		name = nr.InstanceID
	}

	var icon, title string
	color := discordColorBlue
	switch nr.EventType {
	case "ttl_warning":
		icon, title, color = "⏱️", fmt.Sprintf("%s terminates in %s", name, nr.Detail), discordColorYellow
	case "ttl_expired":
		icon, title, color = "🔴", fmt.Sprintf("%s has terminated — scheduled end time reached", name), discordColorRed
	case "idle_warning":
		icon, title, color = "💤", fmt.Sprintf("%s will stop in %s — no activity detected", name, nr.Detail), discordColorYellow
	case "idle_stopped":
		icon, title, color = "⏹️", fmt.Sprintf("%s has stopped — idle timeout reached", name), discordColorRed
	case "idle_hibernated":
		icon, title, color = "💤", fmt.Sprintf("%s has hibernated — idle timeout reached", name), discordColorRed
	case "idle_terminated":
		icon, title, color = "🔴", fmt.Sprintf("%s has terminated — idle timeout reached", name), discordColorRed
	case "completion":
		icon, title, color = "✅", fmt.Sprintf("%s has completed", name), discordColorGreen
	case "spot_interrupt":
		icon, title, color = "⚠️", fmt.Sprintf("%s received a Spot interruption notice — %s", name, nr.Detail), discordColorYellow
	case "pre_stop_start":
		icon, title, color = "🔄", fmt.Sprintf("%s is running its shutdown task before terminating", name), discordColorBlue
	case "pre_stop_failed":
		icon, title, color = "🟠", fmt.Sprintf("%s shutdown task FAILED — output may NOT have been saved", name), discordColorRed
	case "pre_stop_timeout":
		icon, title, color = "🟠", fmt.Sprintf("%s shutdown task TIMED OUT — output may be incomplete", name), discordColorRed
	case "idle_stop_failed":
		icon, title, color = "🟠", fmt.Sprintf("%s could not be stopped at idle timeout — it is still running (and billing)", name), discordColorRed
	case "completion_stop_failed":
		icon, title, color = "🟠", fmt.Sprintf("%s finished its job but could not be stopped — it is still running (and billing)", name), discordColorRed
	case "fsx_mount_failed":
		icon, title, color = "🟠", fmt.Sprintf("%s could not mount its FSx for Lustre filesystem — the workload has no shared storage", name), discordColorRed
	case "fsx_dra_failed":
		icon, title, color = "🟠", fmt.Sprintf("%s FSx data-repository link to S3 FAILED — imported data may be missing and results may not export", name), discordColorRed
	case "region_vacated":
		icon, title, color = "🧹", fmt.Sprintf("%s was the last spawn-managed instance in %s — the region is now vacated", name, nr.Detail), discordColorBlue
	case "spot_replacement_retired":
		icon, title, color = "♻️", fmt.Sprintf("%s was terminated, but its Spot request was left open and launched a replacement — the replacement is cancelling the request and shutting down", replacementSubject(nr)), discordColorYellow
	default:
		icon, title = "ℹ️", fmt.Sprintf("%s: %s", name, nr.EventType)
	}

	embed := discordEmbed{
		Title:     icon + " " + title,
		Color:     color,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
	if nr.DNSName != "" {
		embed.URL = "https://" + nr.DNSName
		embed.Fields = append(embed.Fields, discordEmbedField{Name: "URL", Value: "https://" + nr.DNSName, Inline: false})
	}
	// Surface the error/output tail for failure events (#186, #558).
	if detailEvents[nr.EventType] && nr.Detail != "" {
		embed.Fields = append(embed.Fields, discordEmbedField{Name: "Details", Value: "```" + truncateDetail(nr.Detail, 1000) + "```", Inline: false})
	}
	if nr.InstanceID != "" {
		embed.Fields = append(embed.Fields, discordEmbedField{Name: "Instance", Value: "`" + nr.InstanceID + "`", Inline: true})
	}
	if nr.Region != "" {
		embed.Fields = append(embed.Fields, discordEmbedField{Name: "Region", Value: nr.Region, Inline: true})
	}
	return embed
}

// truncateDetail trims a detail string to max runes (Discord embed field values
// are capped at 1024 chars; we leave headroom for the code fences).
func truncateDetail(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// postDiscordWebhook POSTs an embed to a Discord channel webhook URL (#2).
func postDiscordWebhook(webhookURL string, embed discordEmbed) {
	payload, _ := json.Marshal(map[string]interface{}{
		"embeds": []discordEmbed{embed},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", webhookURL, bytes.NewReader(payload))
	if err != nil {
		logf("discord webhook request error: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		logf("discord webhook call error: %v", err)
		return
	}
	defer resp.Body.Close()
	// Discord returns 204 No Content on success for webhook posts.
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		logf("discord webhook returned %d", resp.StatusCode)
	}
}

// ── Discord interactions (slash commands) — Phase 2 (#2) ─────────────────────
//
// Discord posts every interaction to a single application-wide HTTPS endpoint,
// signed with the application's Ed25519 key (no per-guild secret). The flow:
//   1. verify the Ed25519 signature over (timestamp + raw body) using the app's
//      public key (stored per workspace; one app → one key);
//   2. reply to PING (type 1) with PONG (type 2) — Discord's endpoint handshake;
//   3. for an APPLICATION_COMMAND (type 2), parse it into a SlashCommand, ACK
//      with a DEFERRED response (type 5) within 3s, and post the real result via
//      the interaction follow-up webhook (executeAction → postDiscordResponse).

// Discord interaction + response type constants.
const (
	discordInteractionPing               = 1
	discordInteractionApplicationCommand = 2

	discordResponsePong               = 1
	discordResponseDeferredChannelMsg = 5 // "thinking…" ack; result posted via follow-up
)

// discordInteraction is the subset of Discord's interaction payload we read.
type discordInteraction struct {
	Type    int    `json:"type"`
	ID      string `json:"id"`
	Token   string `json:"token"`
	AppID   string `json:"application_id"`
	GuildID string `json:"guild_id"`
	Data    struct {
		Name    string `json:"name"` // the command, e.g. "spore"
		Options []struct {
			Name  string          `json:"name"`
			Value json.RawMessage `json:"value"`
		} `json:"options"`
	} `json:"data"`
	Member struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	} `json:"member"`
	User struct {
		ID string `json:"id"`
	} `json:"user"`
}

// verifyDiscordSignature checks the Ed25519 signature Discord puts on every
// interaction request: sig is over (timestamp || body), verified with the
// application's public key (hex). All three inputs come from the request.
func verifyDiscordSignature(publicKeyHex, signatureHex, timestamp string, body []byte) error {
	if publicKeyHex == "" {
		return fmt.Errorf("no Discord public key configured for this application")
	}
	pubKey, err := hex.DecodeString(publicKeyHex)
	if err != nil || len(pubKey) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid Discord public key")
	}
	sig, err := hex.DecodeString(signatureHex)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("invalid Discord signature")
	}
	msg := append([]byte(timestamp), body...)
	if !ed25519.Verify(ed25519.PublicKey(pubKey), msg, sig) {
		//lint:ignore ST1005 "Discord" is a proper noun; lowercasing would misspell it, and rewording would change error text callers see (#562)
		return fmt.Errorf("Discord signature verification failed")
	}
	return nil
}

// discordUserID returns the invoking user's ID from either the guild (member) or
// DM (user) shape of an interaction.
func (i *discordInteraction) discordUserID() string {
	if i.Member.User.ID != "" {
		return i.Member.User.ID
	}
	return i.User.ID
}

// discordOptionValue returns the string value of a named subcommand option.
func (i *discordInteraction) optionString(name string) string {
	for _, o := range i.Data.Options {
		if o.Name == name {
			var s string
			if json.Unmarshal(o.Value, &s) == nil {
				return s
			}
		}
	}
	return ""
}

// discordCommand returns the command, nickname and arg of a slash-command
// interaction. The command option is free text, so it is normalised the way
// Slack and Teams text is: trimmed, lowercased, with an optional leading
// "/spore" (or "/<registered name>") removed. If the user typed the whole
// command into it ("status rstudio") and left name and arg empty, it is split
// like Slack text. Empty means help.
func discordCommand(it *discordInteraction) (command, nickname, arg string) {
	_, text := splitSlashPrefix(it.optionString("command"), "/"+it.Data.Name)
	nickname = strings.TrimSpace(it.optionString("name"))
	arg = strings.TrimSpace(it.optionString("arg"))
	if nickname == "" && arg == "" {
		return parseCommandText(text)
	}
	command, _, _ = parseCommandText(text)
	return command, nickname, arg
}

// discordFollowupURL is the webhook URL for posting the deferred result of an
// interaction (PATCH/POST the original response). Editing the original message
// uses .../messages/@original; a fresh follow-up POSTs to the base URL.
func discordFollowupURL(appID, token string) string {
	return fmt.Sprintf("https://discord.com/api/v10/webhooks/%s/%s/messages/@original", appID, token)
}

// postDiscordResponse delivers an async command result to a Discord interaction
// by editing the deferred ("thinking…") message via the follow-up webhook (#2).
//
// The deferred ACK (type 5) and this edit race: the async executor can PATCH
// @original before Discord has registered the ACK, which returns 404 ("there is
// no original message to edit yet"). The ACK lands within a fraction of a
// second, so a 404 is retried with a short backoff rather than treated as fatal.
func postDiscordResponse(followupURL, text string) error {
	payload, _ := json.Marshal(map[string]string{"content": text})

	var lastErr error
	delays := []time.Duration{0, 300 * time.Millisecond, 700 * time.Millisecond, 1500 * time.Millisecond}
	for _, d := range delays {
		if d > 0 {
			time.Sleep(d)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		req, err := http.NewRequestWithContext(ctx, "PATCH", followupURL, bytes.NewReader(payload))
		if err != nil {
			cancel()
			return fmt.Errorf("discord follow-up request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := httpClient.Do(req)
		if err != nil {
			cancel()
			lastErr = fmt.Errorf("discord follow-up call: %w", err)
			continue
		}
		status := resp.StatusCode
		resp.Body.Close()
		cancel()
		if status < 300 {
			return nil
		}
		// 404 = deferred ACK not registered yet; retry. Other 4xx/5xx: don't spin.
		lastErr = fmt.Errorf("discord follow-up returned %d", status)
		if status != http.StatusNotFound {
			return lastErr
		}
	}
	return lastErr
}
