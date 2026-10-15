package main

import (
	"bufio"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// legacyEvents are handled for older spored versions but no longer sent, so
// they are allowed in a handler without being in testdata/spored_events.txt.
var legacyEvents = map[string]bool{
	"idle_terminated": true,
}

// loadSporedEvents reads testdata/spored_events.txt (see its header).
func loadSporedEvents(t *testing.T) map[string]bool {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", "spored_events.txt"))
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()
	events := map[string]bool{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		if line = strings.TrimSpace(line); line != "" {
			events[line] = true
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	if len(events) == 0 {
		t.Fatal("fixture lists no events")
	}
	return events
}

// handledEvents returns the string literals in the case clauses of the switch
// on the event type inside funcName in file. It parses the source rather than
// calling the function, so a case cannot be "handled" by the default branch.
func handledEvents(t *testing.T, file, funcName string) map[string]bool {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, file, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}
	var fn *ast.FuncDecl
	for _, d := range f.Decls {
		if fd, ok := d.(*ast.FuncDecl); ok && fd.Name.Name == funcName {
			fn = fd
		}
	}
	if fn == nil {
		t.Fatalf("%s: func %s not found", file, funcName)
	}
	isEventTag := func(e ast.Expr) bool {
		switch x := e.(type) {
		case *ast.Ident:
			return x.Name == "eventType"
		case *ast.SelectorExpr:
			return x.Sel.Name == "EventType"
		}
		return false
	}
	got := map[string]bool{}
	found := false
	ast.Inspect(fn, func(n ast.Node) bool {
		sw, ok := n.(*ast.SwitchStmt)
		if !ok || sw.Tag == nil || !isEventTag(sw.Tag) {
			return true
		}
		found = true
		for _, st := range sw.Body.List {
			for _, e := range st.(*ast.CaseClause).List {
				if lit, ok := e.(*ast.BasicLit); ok && lit.Kind == token.STRING {
					s, _ := strconv.Unquote(lit.Value)
					got[s] = true
				}
			}
		}
		return true
	})
	if !found {
		t.Fatalf("%s: no switch on the event type in %s", file, funcName)
	}
	return got
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// TestSporedEventsHandled is the gate for #558: every event spored sends (per
// testdata/spored_events.txt) has an explicit case in the Slack, Discord and
// SMS formatters, and no formatter handles an event the list doesn't know.
func TestSporedEventsHandled(t *testing.T) {
	sent := loadSporedEvents(t)
	handlers := []struct{ file, fn string }{
		{"notify.go", "formatNotification"},
		{"discord.go", "buildDiscordEmbed"},
		{"sms_notify.go", "twilioMessage"},
	}
	for _, h := range handlers {
		handled := handledEvents(t, h.file, h.fn)
		for _, ev := range sortedKeys(sent) {
			if !handled[ev] {
				t.Errorf("%s (%s): no case for spored event %q — it falls through to the generic default", h.fn, h.file, ev)
			}
		}
		for _, ev := range sortedKeys(handled) {
			if !sent[ev] && !legacyEvents[ev] {
				t.Errorf("%s (%s) handles %q, which is not in testdata/spored_events.txt — add it there (if spored sends it) or to legacyEvents", h.fn, h.file, ev)
			}
		}
	}
}

// notifyCallRE matches a spored notifier call with a literal event type, e.g.
// a.notifier.Notify(ctx, "idle_stop_failed", ...).
var notifyCallRE = regexp.MustCompile(`\.Notify\([^,()]+,\s*"([a-z0-9_]+)"`)

// TestSporedEventsMatchSpawn checks the fixture against a spawn checkout when
// SPAWN_SRC points at one (skipped otherwise, e.g. in this repo's CI). Every
// literal event spawn sends must be in the fixture. Events chosen through a
// variable (idle_stopped/idle_hibernated) are not seen by the regexp, so the
// reverse direction is not checked.
func TestSporedEventsMatchSpawn(t *testing.T) {
	src := os.Getenv("SPAWN_SRC")
	if src == "" {
		t.Skip("SPAWN_SRC not set; set it to a spawn checkout to compare event lists")
	}
	sent := loadSporedEvents(t)
	seen := map[string]string{}
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if name := d.Name(); name == "vendor" || name == ".git" || name == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, m := range notifyCallRE.FindAllStringSubmatch(string(b), -1) {
			seen[m[1]] = path
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", src, err)
	}
	if len(seen) == 0 {
		t.Fatalf("no Notify(..., \"event\") calls found under %s — wrong path, or the call shape changed", src)
	}
	for _, ev := range sortedKeys(func() map[string]bool {
		m := map[string]bool{}
		for k := range seen {
			m[k] = true
		}
		return m
	}()) {
		if !sent[ev] {
			t.Errorf("spawn sends %q (%s) but testdata/spored_events.txt does not list it", ev, seen[ev])
		}
	}
}

func TestIdleStopFailedCarriesDetail(t *testing.T) {
	const detail = "idle stop failed, instance still running; retrying with backoff: operation error EC2: StopInstances, api error UnsupportedOperation: You can't stop the Spot Instance"
	nr := NotifyRequest{EventType: "idle_stop_failed", InstanceName: "gpu1", InstanceID: "i-0abc", Region: "us-east-1", Detail: detail}

	msg := formatNotification(nr)
	for _, want := range []string{"🟠", "*gpu1*", "still running", "```" + detail + "```"} {
		if !strings.Contains(msg, want) {
			t.Errorf("slack message missing %q:\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "ℹ️") {
		t.Errorf("slack message fell through to the generic default:\n%s", msg)
	}

	e := buildDiscordEmbed(nr)
	if e.Color != discordColorRed {
		t.Errorf("discord color = %#x, want red", e.Color)
	}
	var hasDetail bool
	for _, f := range e.Fields {
		if f.Name == "Details" && strings.Contains(f.Value, "UnsupportedOperation") {
			hasDetail = true
		}
	}
	if !hasDetail {
		t.Errorf("discord embed missing Details field: %+v", e.Fields)
	}

	sms, opts := twilioMessage("gpu1", "idle_stop_failed", map[string]string{"detail": detail})
	if !strings.Contains(sms, "still running") || !strings.Contains(sms, "UnsupportedOperation") {
		t.Errorf("sms missing status or error: %q", sms)
	}
	if len(opts) != 0 {
		t.Errorf("sms options = %v, want none", opts)
	}
}

// TestCompletionStopFailedCarriesDetail covers spored's completion_stop_failed
// (spawn#978, PR #1005): sent once when --on-complete stop|hibernate fails, with
// the action and the EC2 error as Detail (#563).
func TestCompletionStopFailedCarriesDetail(t *testing.T) {
	const detail = "on-complete hibernate failed, instance still running; retrying with backoff: operation error EC2: StopInstances, api error UnsupportedOperation: hibernation is not enabled"
	nr := NotifyRequest{EventType: "completion_stop_failed", InstanceName: "job7", InstanceID: "i-0def", Region: "us-west-2", Detail: detail}

	msg := formatNotification(nr)
	for _, want := range []string{"🟠", "*job7*", "finished its job", "still running", "```" + detail + "```"} {
		if !strings.Contains(msg, want) {
			t.Errorf("slack message missing %q:\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "ℹ️") {
		t.Errorf("slack message fell through to the generic default:\n%s", msg)
	}

	e := buildDiscordEmbed(nr)
	if e.Color != discordColorRed {
		t.Errorf("discord color = %#x, want red", e.Color)
	}
	if !strings.Contains(e.Title, "finished its job") {
		t.Errorf("discord title = %q, want the completion_stop_failed message", e.Title)
	}
	var hasDetail bool
	for _, f := range e.Fields {
		if f.Name == "Details" && strings.Contains(f.Value, "hibernation is not enabled") {
			hasDetail = true
		}
	}
	if !hasDetail {
		t.Errorf("discord embed missing Details field: %+v", e.Fields)
	}

	sms, opts := twilioMessage("job7", "completion_stop_failed", map[string]string{"detail": detail})
	if !strings.Contains(sms, "finished but could not be stopped") || !strings.Contains(sms, "UnsupportedOperation") {
		t.Errorf("sms missing status or error: %q", sms)
	}
	if len(opts) != 0 {
		t.Errorf("sms options = %v, want none", opts)
	}
}

func TestFailureEventsRenderDetail(t *testing.T) {
	for _, ev := range sortedKeys(detailEvents) {
		nr := NotifyRequest{EventType: ev, InstanceName: "x", Detail: "fs-0123: boom"}
		if msg := formatNotification(nr); !strings.Contains(msg, "```fs-0123: boom```") || strings.Contains(msg, "ℹ️") {
			t.Errorf("%s: slack message lacks detail block or is generic:\n%s", ev, msg)
		}
		sms, _ := twilioMessage("x", ev, map[string]string{"detail": "fs-0123: boom"})
		if !strings.Contains(sms, "fs-0123: boom") {
			t.Errorf("%s: sms lacks detail: %q", ev, sms)
		}
	}
}

func TestRegionVacatedNamesRegion(t *testing.T) {
	nr := NotifyRequest{EventType: "region_vacated", InstanceName: "x", Detail: "eu-west-2"}
	if msg := formatNotification(nr); !strings.Contains(msg, "eu-west-2") || strings.Contains(msg, "```") {
		t.Errorf("slack region_vacated: %s", msg)
	}
	if sms, _ := twilioMessage("x", "region_vacated", map[string]string{"detail": "eu-west-2"}); !strings.Contains(sms, "eu-west-2") {
		t.Errorf("sms region_vacated: %q", sms)
	}
}

func TestAppendSMSDetailTruncates(t *testing.T) {
	var b strings.Builder
	appendSMSDetail(&b, strings.Repeat("e", smsDetailMax+50))
	if got := len([]rune(strings.TrimSpace(b.String()))); got != smsDetailMax+1 { // + ellipsis
		t.Errorf("truncated length = %d, want %d", got, smsDetailMax+1)
	}
}

// spot_replacement_retired (spawn#995, #1007) comes from the replacement, whose
// instance name falls back to its own id. Every channel must name the original
// and keep the Spot request id from the detail.
func TestSpotReplacementRetiredNamesTheOriginal(t *testing.T) {
	const detail = "replacement of i-0aaaaaaaaaaaaaaaa launched by leaked Spot request sir-abc123; cancelling the request and shutting down"
	for name, nr := range map[string]NotifyRequest{
		"no dns name": {EventType: "spot_replacement_retired", InstanceName: "i-0bbbbbbbbbbbbbbbb",
			InstanceID: "i-0bbbbbbbbbbbbbbbb", OriginalInstanceID: "i-0aaaaaaaaaaaaaaaa", Detail: detail},
		"dns name": {EventType: "spot_replacement_retired", InstanceName: "web1",
			InstanceID: "i-0bbbbbbbbbbbbbbbb", OriginalInstanceID: "i-0aaaaaaaaaaaaaaaa", Detail: detail},
	} {
		t.Run(name, func(t *testing.T) {
			want := "i-0aaaaaaaaaaaaaaaa"
			if nr.InstanceName == "web1" {
				want = "web1"
			}
			msg := formatNotification(nr)
			for _, s := range []string{"*" + want + "*", "replacement", "sir-abc123"} {
				if !strings.Contains(msg, s) {
					t.Errorf("slack/teams message missing %q:\n%s", s, msg)
				}
			}
			if strings.Contains(msg, "ℹ️") || strings.Contains(msg, "*i-0bbbbbbbbbbbbbbbb*") {
				t.Errorf("slack/teams message is generic or names the replacement as the subject:\n%s", msg)
			}

			e := buildDiscordEmbed(nr)
			if !strings.HasPrefix(e.Title, "♻️ "+want+" ") {
				t.Errorf("discord title = %q, want it to start with the original %q", e.Title, want)
			}
			var hasDetail bool
			for _, f := range e.Fields {
				hasDetail = hasDetail || (f.Name == "Details" && strings.Contains(f.Value, "sir-abc123"))
			}
			if !hasDetail {
				t.Errorf("discord embed lacks the request id: %+v", e.Fields)
			}

			sms, opts := twilioMessage(replacementSubject(nr), nr.EventType, map[string]string{"detail": detail})
			if !strings.HasPrefix(sms, want+" ") || !strings.Contains(sms, "sir-abc123") {
				t.Errorf("sms = %q", sms)
			}
			if len(opts) != 0 {
				t.Errorf("sms offers replies %v for an instance that is shutting down", opts)
			}
		})
	}
}

// The replacement's own id is registered by nobody, so DMs and SMS for
// spot_replacement_retired go to the original's registrations, and only for
// that event and a well-formed, different id.
func TestNotifyTargetInstance(t *testing.T) {
	const repl, orig = "i-0bbbbbbbbbbbbbbbb", "i-0aaaaaaaaaaaaaaaa"
	cases := []struct {
		name string
		nr   NotifyRequest
		want string
	}{
		{"replacement names its original", NotifyRequest{EventType: "spot_replacement_retired", InstanceID: repl, OriginalInstanceID: orig}, orig},
		{"no original: the sender", NotifyRequest{EventType: "spot_replacement_retired", InstanceID: repl}, repl},
		{"malformed original", NotifyRequest{EventType: "spot_replacement_retired", InstanceID: repl, OriginalInstanceID: "sir-1"}, repl},
		{"original equals sender", NotifyRequest{EventType: "spot_replacement_retired", InstanceID: repl, OriginalInstanceID: repl}, repl},
		{"other events ignore the field", NotifyRequest{EventType: "ttl_warning", InstanceID: repl, OriginalInstanceID: orig}, repl},
	}
	for _, tc := range cases {
		if got := notifyTargetInstance(tc.nr); got != tc.want {
			t.Errorf("%s: target = %s, want %s", tc.name, got, tc.want)
		}
	}
}

// handleNotify must gate and deliver on notifyTargetInstance, not on
// nr.InstanceID, or a replacement's notification reaches channel webhooks only.
// handleNotify needs DynamoDB, so this reads its source: every per-user
// delivery and the registration check take `target`, assigned from
// notifyTargetInstance(nr).
func TestHandleNotifyDeliversToTheTarget(t *testing.T) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "notify.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var fn *ast.FuncDecl
	for _, d := range f.Decls {
		if fd, ok := d.(*ast.FuncDecl); ok && fd.Name.Name == "handleNotify" {
			fn = fd
		}
	}
	if fn == nil {
		t.Fatal("handleNotify not found")
	}
	assigned := false
	// callee name -> index of the instance-id argument
	want := map[string]int{"InstanceRegisteredInWorkspace": 3, "sendUserDMs": 4, "sendTeamsDMs": 3, "sendUserSMS": 3}
	seen := map[string]bool{}
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.AssignStmt:
			if id, ok := n.Lhs[0].(*ast.Ident); ok && id.Name == "target" && len(n.Rhs) == 1 {
				if c, ok := n.Rhs[0].(*ast.CallExpr); ok {
					if fid, ok := c.Fun.(*ast.Ident); ok && fid.Name == "notifyTargetInstance" {
						assigned = true
					}
				}
			}
		case *ast.CallExpr:
			var name string
			switch fun := n.Fun.(type) {
			case *ast.Ident:
				name = fun.Name
			case *ast.SelectorExpr:
				name = fun.Sel.Name
			}
			idx, ok := want[name]
			if !ok {
				return true
			}
			seen[name] = true
			if idx >= len(n.Args) {
				t.Errorf("%s: too few arguments", name)
				return true
			}
			if id, ok := n.Args[idx].(*ast.Ident); !ok || id.Name != "target" {
				t.Errorf("%s is not given `target` (argument %d)", name, idx)
			}
		}
		return true
	})
	if !assigned {
		t.Error("handleNotify does not assign target := notifyTargetInstance(nr)")
	}
	for name := range want {
		if !seen[name] {
			t.Errorf("handleNotify no longer calls %s", name)
		}
	}
}
