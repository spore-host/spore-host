package main

// Gate (#611): spore-bot-role's KMS grants on the workspace-credentials key in
// infra/tofu/spore-bot/main.tf are exactly what the code needs. kms:Encrypt
// covers every field the code can seal (sealCredential runs over credFields),
// kms:Decrypt exactly the fields the code opens (discovered from its
// openCredential calls), both on the key's ARN and conditioned on the purpose.
// The key policy names this account only, and the alias and the sweep's event
// match the code.

import (
	"go/ast"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// openedFields returns the credential fields the code passes to
// Registry.openCredential, discovered from the AST.
func openedFields(t *testing.T) map[string]bool {
	t.Helper()
	byName := map[string]credField{
		"credSigningSecret": credSigningSecret, "credBotToken": credBotToken,
		"credRefreshToken": credRefreshToken, "credIncomingWebhookURL": credIncomingWebhookURL,
	}
	if len(byName) != len(credFields()) {
		t.Fatal("byName does not list every credential field")
	}
	out := map[string]bool{}
	for _, f := range loadBotSource(t).files {
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "openCredential" || len(call.Args) < 2 {
				return true
			}
			id, ok := call.Args[1].(*ast.Ident)
			if !ok {
				t.Errorf("openCredential called with a field the gate cannot resolve: %T", call.Args[1])
				return true
			}
			fld, ok := byName[id.Name]
			if !ok {
				t.Errorf("openCredential called with %s, not a credential field", id.Name)
				return true
			}
			out[fld.purpose] = true
			return true
		})
	}
	if len(out) == 0 {
		t.Fatal("discovered no openCredential calls: discovery is broken")
	}
	return out
}

func readTofu(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(tofuMainPath)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// tofuList returns the string elements of `name = [ ... ]` in tf.
func tofuList(t *testing.T, tf, name string) []string {
	t.Helper()
	m := regexp.MustCompile(`(?m)^\s*` + name + `\s*=\s*\[`).FindStringIndex(tf)
	if m == nil {
		t.Fatalf("%s has no %s list", tofuMainPath, name)
	}
	var out []string
	for _, q := range reQuoted.FindAllStringSubmatch(block(t, tf, m[1]-1), -1) {
		out = append(out, q[1])
	}
	return out
}

// kmsStatement is the body of the role-policy statement with sid.
func kmsStatement(t *testing.T, tf, sid string) string {
	t.Helper()
	i := strings.Index(tf, `Sid      = "`+sid+`"`)
	if i < 0 {
		i = strings.Index(tf, `Sid = "`+sid+`"`)
	}
	if i < 0 {
		t.Fatalf("%s has no statement %s", tofuMainPath, sid)
	}
	open := strings.LastIndex(tf[:i], "{")
	return block(t, tf, open)
}

func set(xs []string) map[string]bool {
	m := map[string]bool{}
	for _, x := range xs {
		m[x] = true
	}
	return m
}

func keys(m map[string]bool) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestTofuKMSGrantsMatchTheCredentialCode(t *testing.T) {
	tf := readTofu(t)
	locals := map[string][]string{
		"local.credential_purposes_encrypt": tofuList(t, tf, "credential_purposes_encrypt"),
		"local.credential_purposes_decrypt": tofuList(t, tf, "credential_purposes_decrypt"),
	}

	all := map[string]bool{}
	for _, f := range credFields() {
		all[f.purpose] = true
	}
	want := map[string]map[string]bool{
		"kms:Encrypt": all,
		"kms:Decrypt": openedFields(t),
	}
	if want["kms:Decrypt"][credRefreshToken.purpose] {
		t.Error("the code opens refresh tokens; spore-bot never refreshes, so it should not")
	}

	for sid, action := range map[string]string{
		"SporeBotCredentialsEncrypt": "kms:Encrypt",
		"SporeBotCredentialsDecrypt": "kms:Decrypt",
	} {
		body := kmsStatement(t, tf, sid)
		if !regexp.MustCompile(`Action\s*=\s*\["` + action + `"\]`).MatchString(body) {
			t.Errorf("%s: Action is not exactly [%q]", sid, action)
		}
		if !regexp.MustCompile(`(?m)^\s*Resource\s*=\s*aws_kms_key\.spore_bot_secrets\.arn\s*$`).MatchString(body) {
			t.Errorf("%s: Resource is not aws_kms_key.spore_bot_secrets.arn", sid)
		}
		m := regexp.MustCompile(`"kms:EncryptionContext:purpose"\s*=\s*(local\.[a-z_]+)`).FindStringSubmatch(body)
		if m == nil || !strings.Contains(body, "StringEquals") {
			t.Errorf("%s: no StringEquals kms:EncryptionContext:purpose condition", sid)
			continue
		}
		got := set(locals[m[1]])
		if strings.Join(keys(got), ",") != strings.Join(keys(want[action]), ",") {
			t.Errorf("%s grants %s for purposes %v; the code needs exactly %v", sid, action, keys(got), keys(want[action]))
		}
	}

	// No other statement in the role policy grants KMS.
	r := regexp.MustCompile(`resource\s+"aws_iam_role_policy"\s+"spore_bot"\s*\{`).FindStringIndex(tf)
	if r == nil {
		t.Fatal("no aws_iam_role_policy.spore_bot")
	}
	if n := strings.Count(block(t, tf, r[1]-1), `"kms:`); n != 2+2 { // two actions, two condition keys
		t.Errorf("spore-bot-role's policy mentions %d kms: actions/keys, want the two statements above only", n)
	}
}

func TestTofuKMSKeyIsThisAccountOnly(t *testing.T) {
	tf := readTofu(t)
	i := strings.Index(tf, `resource "aws_kms_key" "spore_bot_secrets"`)
	if i < 0 {
		t.Fatal("no aws_kms_key.spore_bot_secrets")
	}
	key := block(t, tf, i+strings.Index(tf[i:], "{"))
	principals := regexp.MustCompile(`Principal\s*=\s*\{\s*AWS\s*=\s*"([^"]+)"\s*\}`).FindAllStringSubmatch(key, -1)
	if len(principals) != 1 || principals[0][1] != "arn:aws:iam::${local.account_id}:root" {
		t.Errorf("key policy principals = %v; want this account's root only", principals)
	}
	if regexp.MustCompile(`\b\d{12}\b`).MatchString(key) {
		t.Error("the key policy names an account id literally; use local.account_id")
	}
	for _, need := range []string{"enable_key_rotation     = true", "prevent_destroy = true"} {
		if !strings.Contains(key, need) {
			t.Errorf("aws_kms_key.spore_bot_secrets lacks %q", need)
		}
	}
	// PutRolePolicy rejects policy variables in a Resource ("failed legacy
	// parsing"), though validators accept them.
	if regexp.MustCompile(`(?m)Resource\s*=.*\$\{aws:`).MatchString(tf) {
		t.Error("a Resource uses an IAM policy variable; PutRolePolicy rejects it")
	}
}

func TestTofuAliasAndSweepMatchTheCode(t *testing.T) {
	tf := readTofu(t)
	if !strings.Contains(tf, `name          = "`+defaultSecretsKeyAlias+`"`) {
		t.Errorf("aws_kms_alias does not create %s", defaultSecretsKeyAlias)
	}
	if !strings.Contains(tf, `input = jsonencode({ spore_bot_task = "`+sealLegacyCredentialsTask+`" })`) {
		t.Errorf("the sweep's event target does not send spore_bot_task = %s", sealLegacyCredentialsTask)
	}
	// The alias follows seal_workspace_credentials alone. The sweep follows
	// local.seal_sweep_enabled, which must include seal_workspace_credentials
	// so the sweep never runs before the key it seals with is the alias target.
	gates := []struct{ resource, gate string }{
		{`resource "aws_kms_alias" "spore_bot_secrets"`, "var.seal_workspace_credentials ? 1 : 0"},
		{`resource "aws_cloudwatch_event_rule" "seal_legacy_credentials"`, "local.seal_sweep_enabled ? 1 : 0"},
		{`resource "aws_cloudwatch_event_target" "seal_legacy_credentials"`, "local.seal_sweep_enabled ? 1 : 0"},
		{`resource "aws_lambda_permission" "seal_legacy_credentials"`, "local.seal_sweep_enabled ? 1 : 0"},
	}
	for _, g := range gates {
		i := strings.Index(tf, g.resource)
		if i < 0 {
			t.Errorf("main.tf has no %s", g.resource)
			continue
		}
		if !regexp.MustCompile(`count\s*=\s*` + regexp.QuoteMeta(g.gate)).MatchString(block(t, tf, i+strings.Index(tf[i:], "{"))) {
			t.Errorf("%s is not gated on %s", g.resource, g.gate)
		}
	}
	if !regexp.MustCompile(`(?m)^\s*seal_sweep_enabled\s*=\s*var\.seal_workspace_credentials\s*&&`).MatchString(tf) {
		t.Error("local.seal_sweep_enabled does not require var.seal_workspace_credentials")
	}
}

// The decommission switch (#611): the public Function URL and its public invoke
// permission exist only while public_endpoint_enabled is true, and it defaults
// to false, so the hosted bot stays off the internet unless someone opts in.
func TestTofuPublicEndpointIsOptIn(t *testing.T) {
	tf := readTofu(t)
	v := regexp.MustCompile(`variable\s+"public_endpoint_enabled"\s*\{`).FindStringIndex(tf)
	if v == nil {
		t.Fatal("main.tf has no variable public_endpoint_enabled")
	}
	if !regexp.MustCompile(`(?m)^\s*default\s*=\s*false\s*$`).MatchString(block(t, tf, v[1]-1)) {
		t.Error("public_endpoint_enabled does not default to false")
	}
	for _, r := range []string{
		`resource "aws_lambda_function_url" "spore_bot"`,
		`resource "aws_lambda_permission" "url_public"`,
	} {
		i := strings.Index(tf, r)
		if i < 0 {
			t.Errorf("main.tf has no %s", r)
			continue
		}
		if !regexp.MustCompile(`count\s*=\s*var\.public_endpoint_enabled \? 1 : 0`).MatchString(block(t, tf, i+strings.Index(tf[i:], "{"))) {
			t.Errorf("%s is not gated on var.public_endpoint_enabled", r)
		}
	}
	if !regexp.MustCompile(`(?m)^\s*seal_sweep_enabled\s*=.*&&\s*var\.public_endpoint_enabled\s*$`).MatchString(tf) {
		t.Error("the sealing sweep is not removed with the public endpoint")
	}
}
