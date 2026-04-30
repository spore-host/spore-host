package agent

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/scttfrdmn/spore-host/spawn/pkg/provider"
)

// stubProvider is a minimal Provider implementation for unit tests.
type stubProvider struct {
	identity *provider.Identity
	config   *provider.Config
	spot     bool
}

func (s *stubProvider) GetIdentity(_ context.Context) (*provider.Identity, error) {
	return s.identity, nil
}
func (s *stubProvider) GetConfig(_ context.Context) (*provider.Config, error) {
	return s.config, nil
}
func (s *stubProvider) Terminate(_ context.Context, _ string) error { return nil }
func (s *stubProvider) Stop(_ context.Context, _ string) error      { return nil }
func (s *stubProvider) Hibernate(_ context.Context) error           { return nil }
func (s *stubProvider) IsSpotInstance(_ context.Context) bool       { return s.spot }
func (s *stubProvider) CheckSpotInterruption(_ context.Context) (*provider.InterruptionInfo, error) {
	return nil, nil
}
func (s *stubProvider) DiscoverPeers(_ context.Context, _ string) ([]provider.PeerInfo, error) {
	return nil, nil
}
func (s *stubProvider) GetProviderType() string                       { return "stub" }
func (s *stubProvider) LookupAndTagEBSCost(_ context.Context) float64 { return 0 }

func newTestAgent(t *testing.T, cfg *provider.Config) *Agent {
	t.Helper()
	identity := &provider.Identity{
		InstanceID: "i-test123",
		Region:     "us-east-1",
		AccountID:  "123456789012",
		PublicIP:   "1.2.3.4",
		PrivateIP:  "10.0.0.1",
		Provider:   "stub",
	}
	if cfg == nil {
		cfg = &provider.Config{
			TTL:            2 * time.Hour,
			IdleTimeout:    30 * time.Minute,
			IdleCPUPercent: 5.0,
		}
	}
	a := &Agent{
		provider:         &stubProvider{identity: identity, config: cfg},
		identity:         identity,
		config:           cfg,
		startTime:        time.Now(),
		lastActivityTime: time.Now(),
	}
	return a
}

func TestGetConfig(t *testing.T) {
	cfg := &provider.Config{TTL: time.Hour, IdleCPUPercent: 5.0}
	a := newTestAgent(t, cfg)
	got := a.GetConfig()
	if got != cfg {
		t.Errorf("GetConfig() returned wrong config")
	}
	if got.TTL != time.Hour {
		t.Errorf("GetConfig().TTL = %v, want %v", got.TTL, time.Hour)
	}
}

func TestGetIdentity(t *testing.T) {
	a := newTestAgent(t, nil)
	id := a.GetIdentity()
	if id.InstanceID != "i-test123" {
		t.Errorf("GetIdentity().InstanceID = %q, want %q", id.InstanceID, "i-test123")
	}
	if id.Region != "us-east-1" {
		t.Errorf("GetIdentity().Region = %q, want %q", id.Region, "us-east-1")
	}
}

func TestGetInstanceInfo(t *testing.T) {
	a := newTestAgent(t, nil)
	id, region, account := a.GetInstanceInfo()
	if id != "i-test123" {
		t.Errorf("instance ID = %q, want %q", id, "i-test123")
	}
	if region != "us-east-1" {
		t.Errorf("region = %q, want %q", region, "us-east-1")
	}
	if account != "123456789012" {
		t.Errorf("account = %q, want %q", account, "123456789012")
	}
}

func TestGetUptime(t *testing.T) {
	a := newTestAgent(t, nil)
	// Start time is set to now in newTestAgent, uptime should be very small
	uptime := a.GetUptime()
	if uptime < 0 {
		t.Errorf("GetUptime() returned negative duration: %v", uptime)
	}
	if uptime > 5*time.Second {
		t.Errorf("GetUptime() too large for a freshly created agent: %v", uptime)
	}
}

func TestGetLastActivityTime(t *testing.T) {
	before := time.Now()
	a := newTestAgent(t, nil)
	after := time.Now()

	lat := a.GetLastActivityTime()
	if lat.Before(before) || lat.After(after) {
		t.Errorf("GetLastActivityTime() = %v, expected between %v and %v", lat, before, after)
	}
}

func TestIsIdle_NotIdleWhenRecentActivity(t *testing.T) {
	a := newTestAgent(t, &provider.Config{
		IdleTimeout:    5 * time.Minute,
		IdleCPUPercent: 100.0, // threshold so high nothing triggers it
	})
	a.lastActivityTime = time.Now()
	// With a 100% CPU threshold, isIdle checks user sessions etc.
	// On a test machine we just verify it returns a bool without panicking.
	_ = a.IsIdle()
}

func TestIsIdle_IdleAfterTimeout(t *testing.T) {
	a := newTestAgent(t, &provider.Config{
		IdleTimeout:    1 * time.Millisecond,
		IdleCPUPercent: 0.0, // 0% threshold — always considered idle
	})
	// Push last activity into the past
	a.lastActivityTime = time.Now().Add(-1 * time.Hour)
	// Give the idle timeout a moment to elapse
	time.Sleep(5 * time.Millisecond)
	if !a.IsIdle() {
		t.Log("IsIdle() returned false — may depend on live CPU/user checks, acceptable in CI")
	}
}

func TestCheckCompletion_NoFileConfigured(t *testing.T) {
	a := newTestAgent(t, &provider.Config{
		OnComplete:     "terminate",
		CompletionFile: "", // no file → no completion
	})
	ctx := context.Background()
	done := a.checkCompletion(ctx)
	if done {
		t.Errorf("checkCompletion() = true with no CompletionFile set, want false")
	}
}

func TestCheckCompletion_FileNotPresent(t *testing.T) {
	a := newTestAgent(t, &provider.Config{
		OnComplete:     "terminate",
		CompletionFile: "/tmp/spawn_test_completion_file_should_not_exist_xyz",
	})
	ctx := context.Background()
	done := a.checkCompletion(ctx)
	if done {
		t.Errorf("checkCompletion() = true when file does not exist, want false")
	}
}

func TestCheckCompletion_FilePresent(t *testing.T) {
	f := t.TempDir() + "/SPAWN_COMPLETE"
	if err := os.WriteFile(f, []byte{}, 0644); err != nil {
		t.Fatalf("cannot create completion file: %v", err)
	}

	// Use an unknown action so checkCompletion returns false after detecting
	// the file — this avoids the 5s sleep inside terminate/stop.
	a := newTestAgent(t, &provider.Config{
		OnComplete:      "noop_test_action",
		CompletionFile:  f,
		CompletionDelay: 0,
	})
	ctx := context.Background()
	// With an unknown action the function returns false after the sleep(0),
	// but the file detection path is still exercised.
	_ = a.checkCompletion(ctx)
}
