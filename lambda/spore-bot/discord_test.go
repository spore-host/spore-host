package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildDiscordEmbed_ColorAndFields(t *testing.T) {
	nr := NotifyRequest{
		Platform:     "discord",
		EventType:    "ttl_warning",
		InstanceName: "rstudio",
		InstanceID:   "i-0abc123",
		Region:       "us-west-2",
		DNSName:      "rstudio.5k0zfnmq.spore.host",
		Detail:       "10m",
	}
	e := buildDiscordEmbed(nr)

	if e.Color != discordColorYellow {
		t.Errorf("ttl_warning color = %#x, want yellow %#x", e.Color, discordColorYellow)
	}
	if !strings.Contains(e.Title, "rstudio") || !strings.Contains(e.Title, "10m") {
		t.Errorf("title = %q, want instance name + detail", e.Title)
	}
	if e.URL != "https://rstudio.5k0zfnmq.spore.host" {
		t.Errorf("url = %q", e.URL)
	}
	// Expect URL, Instance, Region fields.
	var hasInstance, hasRegion bool
	for _, f := range e.Fields {
		if f.Name == "Instance" && strings.Contains(f.Value, "i-0abc123") {
			hasInstance = true
		}
		if f.Name == "Region" && f.Value == "us-west-2" {
			hasRegion = true
		}
	}
	if !hasInstance || !hasRegion {
		t.Errorf("missing Instance/Region fields: %+v", e.Fields)
	}
}

func TestBuildDiscordEmbed_SeverityColors(t *testing.T) {
	cases := map[string]int{
		"completion":       discordColorGreen,
		"ttl_expired":      discordColorRed,
		"idle_stopped":     discordColorRed,
		"spot_interrupt":   discordColorYellow,
		"idle_warning":     discordColorYellow,
		"pre_stop_start":   discordColorBlue,
		"pre_stop_failed":  discordColorRed,
		"pre_stop_timeout": discordColorRed,
	}
	for event, want := range cases {
		e := buildDiscordEmbed(NotifyRequest{EventType: event, InstanceName: "x"})
		if e.Color != want {
			t.Errorf("%s color = %#x, want %#x", event, e.Color, want)
		}
	}
}

func TestBuildDiscordEmbed_PreStopFailureCarriesDetail(t *testing.T) {
	e := buildDiscordEmbed(NotifyRequest{
		EventType:    "pre_stop_failed",
		InstanceName: "gpu1",
		Detail:       "exit 1 — fatal error: Unable to locate credentials",
	})
	var hasDetail bool
	for _, f := range e.Fields {
		if f.Name == "Details" && strings.Contains(f.Value, "Unable to locate credentials") {
			hasDetail = true
		}
	}
	if !hasDetail {
		t.Errorf("pre_stop_failed embed should carry a Details field with the hook output: %+v", e.Fields)
	}
}

func TestBuildDiscordEmbed_UnknownEventDefaultsBlue(t *testing.T) {
	e := buildDiscordEmbed(NotifyRequest{EventType: "something_new", InstanceName: "x"})
	if e.Color != discordColorBlue {
		t.Errorf("unknown event color = %#x, want blue", e.Color)
	}
}

func TestVerifyDiscordSignature_Valid(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	ts := "1700000000"
	body := []byte(`{"type":1}`)
	sig := ed25519.Sign(priv, append([]byte(ts), body...))
	err := verifyDiscordSignature(hex.EncodeToString(pub), hex.EncodeToString(sig), ts, body)
	if err != nil {
		t.Errorf("valid signature rejected: %v", err)
	}
}

func TestVerifyDiscordSignature_Tampered(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	ts := "1700000000"
	sig := ed25519.Sign(priv, append([]byte(ts), []byte(`{"type":1}`)...))
	// Verify against a DIFFERENT body — must fail.
	err := verifyDiscordSignature(hex.EncodeToString(pub), hex.EncodeToString(sig), ts, []byte(`{"type":2}`))
	if err == nil {
		t.Error("tampered body passed verification")
	}
}

func TestVerifyDiscordSignature_WrongKey(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(nil)
	otherPub, _, _ := ed25519.GenerateKey(nil)
	ts := "1700000000"
	body := []byte(`{"type":1}`)
	sig := ed25519.Sign(priv, append([]byte(ts), body...))
	if err := verifyDiscordSignature(hex.EncodeToString(otherPub), hex.EncodeToString(sig), ts, body); err == nil {
		t.Error("signature verified against the wrong public key")
	}
}

func TestVerifyDiscordSignature_BadInputs(t *testing.T) {
	if err := verifyDiscordSignature("", "aa", "1", []byte("x")); err == nil {
		t.Error("empty public key should error")
	}
	if err := verifyDiscordSignature("zzzz", "aa", "1", []byte("x")); err == nil {
		t.Error("non-hex public key should error")
	}
}

func TestDiscordInteraction_ParseOptions(t *testing.T) {
	raw := `{
	  "type": 2, "guild_id": "g1", "application_id": "app1", "token": "tok1",
	  "member": {"user": {"id": "u123"}},
	  "data": {"name": "spore", "options": [
	    {"name": "command", "value": "status"},
	    {"name": "name", "value": "rstudio"},
	    {"name": "arg", "value": "4h"}
	  ]}
	}`
	var it discordInteraction
	if err := json.Unmarshal([]byte(raw), &it); err != nil {
		t.Fatal(err)
	}
	if it.discordUserID() != "u123" {
		t.Errorf("user id = %q, want u123", it.discordUserID())
	}
	if it.optionString("command") != "status" || it.optionString("name") != "rstudio" || it.optionString("arg") != "4h" {
		t.Errorf("options parsed wrong: cmd=%q name=%q arg=%q", it.optionString("command"), it.optionString("name"), it.optionString("arg"))
	}
	if it.optionString("missing") != "" {
		t.Error("missing option should be empty")
	}
}

func TestDiscordFollowupURL(t *testing.T) {
	got := discordFollowupURL("app1", "tok1")
	want := "https://discord.com/api/v10/webhooks/app1/tok1/messages/@original"
	if got != want {
		t.Errorf("followup url = %q, want %q", got, want)
	}
}

// TestDiscordCommand: the command option is free text, so it is trimmed,
// lowercased and may carry a "/spore" prefix or the whole command, as Slack
// and Teams text may (#575).
func TestDiscordCommand(t *testing.T) {
	tests := []struct {
		name                       string
		cmdName                    string // data.name
		command, nick, arg         string
		wantCmd, wantNick, wantArg string
	}{
		{name: "plain", cmdName: "spore", command: "status", nick: "rstudio",
			wantCmd: "status", wantNick: "rstudio"},
		{name: "empty is help", cmdName: "spore", wantCmd: "help"},
		{name: "case and whitespace", cmdName: "spore", command: "  List ", wantCmd: "list"},
		{name: "spore prefix", cmdName: "spore", command: "/spore list", wantCmd: "list"},
		{name: "registered name prefix", cmdName: "prism", command: "/prism stop", nick: "rstudio",
			wantCmd: "stop", wantNick: "rstudio"},
		{name: "prefix only", cmdName: "spore", command: "/spore", wantCmd: "help"},
		{name: "whole command in the option", cmdName: "spore", command: "/spore extend  rstudio 2h",
			wantCmd: "extend", wantNick: "rstudio", wantArg: "2h"},
		{name: "options win over extra words", cmdName: "spore", command: "extend other", nick: " rstudio ", arg: "2h",
			wantCmd: "extend", wantNick: "rstudio", wantArg: "2h"},
		{name: "arg without name stays the arg", cmdName: "spore", command: "extend", arg: "2h",
			wantCmd: "extend", wantArg: "2h"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var opts []map[string]string
			for k, v := range map[string]string{"command": tt.command, "name": tt.nick, "arg": tt.arg} {
				if v != "" {
					opts = append(opts, map[string]string{"name": k, "value": v})
				}
			}
			body, _ := json.Marshal(map[string]any{"type": 2, "data": map[string]any{"name": tt.cmdName, "options": opts}})
			var it discordInteraction
			if err := json.Unmarshal(body, &it); err != nil {
				t.Fatal(err)
			}
			c, n, a := discordCommand(&it)
			if c != tt.wantCmd || n != tt.wantNick || a != tt.wantArg {
				t.Errorf("discordCommand = %q, %q, %q; want %q, %q, %q", c, n, a, tt.wantCmd, tt.wantNick, tt.wantArg)
			}
		})
	}
}
