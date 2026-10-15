package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// postSlackDM opens a DM by posting to chat.postMessage with the user ID as the
// channel, under its own bounded deadline rather than the caller's context.
func TestPostSlackDM_PostsToChatPostMessageWithOwnDeadline(t *testing.T) {
	var got *http.Request
	var body map[string]string
	orig := httpClient
	t.Cleanup(func() { httpClient = orig })
	httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		got = r
		b, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(b, &body); err != nil {
			t.Errorf("payload is not JSON: %v", err)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":false,"error":"channel_not_found"}`)),
			Header: http.Header{}}, nil
	})}

	postSlackDM("xoxb-test", "U123", "hello")

	if got == nil {
		t.Fatal("no request sent")
	}
	if got.Method != http.MethodPost || got.URL.String() != "https://slack.com/api/chat.postMessage" {
		t.Errorf("request = %s %s, want POST https://slack.com/api/chat.postMessage", got.Method, got.URL)
	}
	if a := got.Header.Get("Authorization"); a != "Bearer xoxb-test" {
		t.Errorf("Authorization = %q", a)
	}
	if body["channel"] != "U123" || body["text"] != "hello" {
		t.Errorf("payload = %v, want channel U123 and text hello", body)
	}
	dl, ok := got.Context().Deadline()
	if !ok {
		t.Fatal("request context has no deadline")
	}
	if d := time.Until(dl); d <= 0 || d > 8*time.Second {
		t.Errorf("deadline in %v, want within 8s", d)
	}
}
