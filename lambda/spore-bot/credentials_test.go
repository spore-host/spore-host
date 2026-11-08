package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"maps"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
	"github.com/aws/smithy-go"
)

// fakeKMS behaves like KMS where it matters here: the blob is opaque (it does
// not contain the plaintext), is long enough to read as a ciphertext, and
// decrypts only with the encryption context it was made with.
type fakeKMS struct {
	mu                 sync.Mutex
	encrypts, decrypts int
	sealed             map[string]sealedEntry
	keys               []string // KeyId of each Encrypt
	encryptErr         error    // returned by Encrypt when set
	decryptErr         error    // returned by Decrypt when set
	onEncrypt          func()   // runs inside Encrypt (a concurrent writer)
}

type sealedEntry struct {
	plaintext []byte
	ctx       map[string]string
}

func (f *fakeKMS) Encrypt(_ context.Context, in *kms.EncryptInput, _ ...func(*kms.Options)) (*kms.EncryptOutput, error) {
	f.mu.Lock()
	f.encrypts++
	f.keys = append(f.keys, aws.ToString(in.KeyId))
	if f.encryptErr != nil {
		f.mu.Unlock()
		return nil, f.encryptErr
	}
	if f.sealed == nil {
		f.sealed = map[string]sealedEntry{}
	}
	blob := bytes.Repeat([]byte{byte(len(f.sealed))}, 180)
	blob[0] = 0xA5
	f.sealed[string(blob)] = sealedEntry{plaintext: bytes.Clone(in.Plaintext), ctx: maps.Clone(in.EncryptionContext)}
	hook := f.onEncrypt
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	return &kms.EncryptOutput{CiphertextBlob: blob}, nil
}

func (f *fakeKMS) Decrypt(_ context.Context, in *kms.DecryptInput, _ ...func(*kms.Options)) (*kms.DecryptOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.decrypts++
	if f.decryptErr != nil {
		return nil, f.decryptErr
	}
	e, ok := f.sealed[string(in.CiphertextBlob)]
	if !ok {
		return nil, &kmstypes.InvalidCiphertextException{}
	}
	if !maps.Equal(e.ctx, in.EncryptionContext) {
		return nil, &kmstypes.InvalidCiphertextException{Message: aws.String("encryption context mismatch")}
	}
	return &kms.DecryptOutput{Plaintext: e.plaintext}, nil
}

// kmsNotFound is KMS's answer for an alias that does not exist, wrapped the
// way the SDK returns it.
func kmsNotFound() error {
	return &smithy.OperationError{ServiceID: "KMS", OperationName: "Encrypt",
		Err: &kmstypes.NotFoundException{Message: aws.String("Alias arn:aws:kms:us-east-1:111122223333:alias/spore-bot-secrets is not found.")}}
}

// captureNotices resets the once-only notices and returns a function giving
// the credential notices logged since.
func captureNotices(t *testing.T) func() []string {
	t.Helper()
	notices.Range(func(k, _ any) bool { notices.Delete(k); return true })
	w := &lockedBuffer{}
	log.SetOutput(w)
	t.Cleanup(func() {
		log.SetOutput(os.Stderr)
		notices.Range(func(k, _ any) bool { notices.Delete(k); return true })
	})
	return func() []string {
		var out []string
		for _, l := range strings.Split(w.String(), "\n") {
			if strings.Contains(l, "credentials: ") {
				out = append(out, l)
			}
		}
		return out
	}
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// Legacy (pre-encryption) shapes, worded so secret scanners do not flag them.
var legacyCreds = map[credField]string{
	credSigningSecret:      strings.Repeat("0123456789abcdef", 2), // Slack: 32 hex chars, valid base64 but short
	credBotToken:           "xoxb-not-a-real-bot-token-fixture",
	credRefreshToken:       "xoxe-1-not-a-real-refresh-token-fixture",
	credIncomingWebhookURL: "https://hooks.example.invalid/not-a-real-webhook-fixture",
}

func legacyWorkspace(key string) *WorkspaceConfig {
	return &WorkspaceConfig{
		WorkspaceKey:       key,
		Platform:           "slack",
		SigningSecret:      legacyCreds[credSigningSecret],
		BotToken:           legacyCreds[credBotToken],
		RefreshToken:       legacyCreds[credRefreshToken],
		IncomingWebhookURL: legacyCreds[credIncomingWebhookURL],
	}
}

// rawItem reads an item exactly as stored.
func rawItem(t *testing.T, reg *Registry, key string) map[string]dynamodbtypes.AttributeValue {
	t.Helper()
	out, err := reg.client.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName: aws.String(reg.workspacesTable),
		Key:       map[string]dynamodbtypes.AttributeValue{"workspace_key": &dynamodbtypes.AttributeValueMemberS{Value: key}},
	})
	if err != nil || out.Item == nil {
		t.Fatalf("get %s: %v (item %v)", key, err, out)
	}
	return out.Item
}

// putRaw stores item as given, the way an older writer (or spawn) would.
func putRaw(t *testing.T, reg *Registry, item map[string]dynamodbtypes.AttributeValue) {
	t.Helper()
	if _, err := reg.client.PutItem(context.Background(), &dynamodb.PutItemInput{
		TableName: aws.String(reg.workspacesTable), Item: item,
	}); err != nil {
		t.Fatalf("put: %v", err)
	}
}

func legacyItem(key string) map[string]dynamodbtypes.AttributeValue {
	item := map[string]dynamodbtypes.AttributeValue{
		"workspace_key": &dynamodbtypes.AttributeValueMemberS{Value: key},
		"platform":      &dynamodbtypes.AttributeValueMemberS{Value: "slack"},
	}
	for f, v := range legacyCreds {
		item[f.attribute] = &dynamodbtypes.AttributeValueMemberS{Value: v}
	}
	return item
}

// The contract with spawn's pkg/botsecret. Both sides must agree on every
// value here, or one side's ciphertext will not open on the other.
func TestCredentialContractMatchesSpawnBotsecret(t *testing.T) {
	want := map[string]string{ // attribute -> purpose, as in spawn pkg/botsecret
		"signing_secret":       "spore-bot-signing-secret",
		"bot_token":            "spore-bot-bot-token",
		"refresh_token":        "spore-bot-refresh-token",
		"incoming_webhook_url": "spore-bot-incoming-webhook-url",
	}
	got := map[string]string{}
	for _, f := range credFields() {
		got[f.attribute] = f.purpose
		ctx := f.encryptionContext("slack#T1#A1")
		if !maps.Equal(ctx, map[string]string{"purpose": f.purpose, "workspace_key": "slack#T1#A1"}) {
			t.Errorf("%s: encryption context %v", f, ctx)
		}
	}
	if !maps.Equal(got, want) {
		t.Errorf("credential fields = %v, want %v", got, want)
	}
	if defaultSecretsKeyAlias != "alias/spore-bot-secrets" {
		t.Errorf("default key = %s", defaultSecretsKeyAlias)
	}
	if sealLegacyCredentialsTask != "seal-legacy-credentials" {
		t.Errorf("sweep task = %s; spawn's deployment/cloudformation/spore-bot.yaml sends seal-legacy-credentials", sealLegacyCredentialsTask)
	}
	// The dynamodbav tags of WorkspaceConfig are the same attributes.
	for _, f := range credFields() {
		ws := WorkspaceConfig{}
		*f.field(&ws) = "x"
		item, err := attributevalue.MarshalMap(&ws)
		if err != nil {
			t.Fatal(err)
		}
		if stringAttr(item, f.attribute) != "x" {
			t.Errorf("%s: WorkspaceConfig does not store it as %q", f, f.attribute)
		}
	}
}

// isEncrypted must agree with spawn's security.IsEncrypted on both formats.
func TestIsEncrypted(t *testing.T) {
	for f, v := range legacyCreds {
		if isEncrypted(v) {
			t.Errorf("legacy %s reads as ciphertext", f)
		}
	}
	if !isEncrypted(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xA5}, 180))) {
		t.Error("a KMS-sized blob does not read as ciphertext")
	}
	if isEncrypted("") {
		t.Error(`"" reads as ciphertext`)
	}
}

// PutWorkspace stores every credential sealed, bound to its field and item,
// and leaves the caller's struct in plaintext.
func TestPutWorkspace_SealsEveryCredentialAtRest(t *testing.T) {
	reg := setupRegistry(t)
	fk := reg.kms.(*fakeKMS)
	ctx := context.Background()
	ws := legacyWorkspace("slack#T1#A1")
	if err := reg.PutWorkspace(ctx, ws); err != nil {
		t.Fatal(err)
	}
	if ws.BotToken != legacyCreds[credBotToken] {
		t.Fatalf("PutWorkspace replaced the caller's bot token with %q", ws.BotToken)
	}
	item := rawItem(t, reg, "slack#T1#A1")
	for _, f := range credFields() {
		stored := stringAttr(item, f.attribute)
		if !isEncrypted(stored) || strings.Contains(stored, legacyCreds[f]) {
			t.Errorf("%s stored as %q, want ciphertext", f, stored)
		}
		got, err := reg.openCredential(ctx, f, "slack#T1#A1", stored)
		if err != nil || got != legacyCreds[f] {
			t.Errorf("open %s = %q, %v", f, got, err)
		}
	}
	if fk.encrypts != 4 {
		t.Errorf("Encrypt calls = %d, want 4", fk.encrypts)
	}
	for _, k := range fk.keys {
		if k != defaultSecretsKeyAlias {
			t.Errorf("sealed under %q, want %s", k, defaultSecretsKeyAlias)
		}
	}
	// Each ciphertext opens only as its own field.
	if _, err := reg.openCredential(ctx, credBotToken, "slack#T1#A1", stringAttr(item, "signing_secret")); err == nil {
		t.Error("a sealed signing secret opened as a bot token")
	}
}

// oauth.go writes the same credentials under two keys. Each copy must be
// sealed for its own key: a value sealed for one does not open under the other.
func TestPutWorkspace_TwoKeysSealedSeparately(t *testing.T) {
	reg := setupRegistry(t)
	ctx := context.Background()
	ws := legacyWorkspace("slack#T1#A1")
	if err := reg.PutWorkspace(ctx, ws); err != nil {
		t.Fatal(err)
	}
	cmdWS := *ws // what handleOAuthCallback does
	cmdWS.WorkspaceKey = "slack#T1#/spore"
	if err := reg.PutWorkspace(ctx, &cmdWS); err != nil {
		t.Fatal(err)
	}
	app, cmd := rawItem(t, reg, "slack#T1#A1"), rawItem(t, reg, "slack#T1#/spore")
	for _, f := range credFields() {
		if got, err := reg.openCredential(ctx, f, "slack#T1#/spore", stringAttr(cmd, f.attribute)); err != nil || got != legacyCreds[f] {
			t.Errorf("command-scoped %s = %q, %v", f, got, err)
		}
		if _, err := reg.openCredential(ctx, f, "slack#T1#/spore", stringAttr(app, f.attribute)); err == nil {
			t.Errorf("app-scoped %s opened under the command-scoped key", f)
		}
	}
}

// A legacy plaintext value reads with no KMS call (and no client at all), and
// is logged once per field, without the value.
func TestOpenCredential_LegacyPlaintextPassesThroughLoggedOnce(t *testing.T) {
	logs := captureNotices(t)
	for _, reg := range []*Registry{{kms: &fakeKMS{}}, {}} {
		for range 3 {
			for f, v := range legacyCreds {
				if got, err := reg.openCredential(context.Background(), f, "slack#T1", v); err != nil || got != v {
					t.Fatalf("open legacy %s = %q, %v", f, got, err)
				}
			}
		}
		if fk, ok := reg.kms.(*fakeKMS); ok && fk.decrypts != 0 {
			t.Errorf("Decrypt calls = %d for plaintext, want 0", fk.decrypts)
		}
	}
	got := logs()
	if len(got) != len(credFields()) {
		t.Fatalf("logged %d notices, want one per field (%d): %q", len(got), len(credFields()), got)
	}
	for _, l := range got {
		for _, v := range legacyCreds {
			if strings.Contains(l, v) {
				t.Errorf("notice %q contains the credential", l)
			}
		}
	}
}

// Before the key exists, writes store the legacy format (which every deployed
// reader, old or new, handles) and log once. Any other KMS failure, or a
// missing key that was named explicitly, refuses the write.
func TestPutWorkspace_RolloutWindowAndFailures(t *testing.T) {
	logs := captureNotices(t)
	reg := setupRegistry(t)
	reg.kms = &fakeKMS{encryptErr: kmsNotFound()}
	if err := reg.PutWorkspace(context.Background(), legacyWorkspace("slack#T1")); err != nil {
		t.Fatalf("PutWorkspace before the key exists = %v, want the legacy write", err)
	}
	item := rawItem(t, reg, "slack#T1")
	for f, v := range legacyCreds {
		if stringAttr(item, f.attribute) != v {
			t.Errorf("%s stored as %q, want the legacy plaintext", f, stringAttr(item, f.attribute))
		}
	}
	_ = reg.PutWorkspace(context.Background(), legacyWorkspace("slack#T2"))
	if n := len(logs()); n != 1 {
		t.Errorf("logged %d notices over two unsealed writes, want 1: %q", n, logs())
	}

	for name, tc := range map[string]struct {
		keyID string
		err   error
	}{
		"explicit key not found": {keyID: "alias/someone-elses", err: kmsNotFound()},
		"access denied":          {err: &smithy.GenericAPIError{Code: "AccessDeniedException"}},
		"disabled key":           {err: &kmstypes.DisabledException{}},
		"pending deletion":       {err: &kmstypes.KMSInvalidStateException{}},
	} {
		t.Run(name, func(t *testing.T) {
			reg.kms, reg.kmsKeyID = &fakeKMS{encryptErr: tc.err}, tc.keyID
			if err := reg.PutWorkspace(context.Background(), legacyWorkspace("slack#T3")); err == nil {
				t.Fatal("PutWorkspace succeeded; want an error")
			}
			if out, _ := reg.client.GetItem(context.Background(), &dynamodb.GetItemInput{
				TableName: aws.String(reg.workspacesTable),
				Key:       map[string]dynamodbtypes.AttributeValue{"workspace_key": &dynamodbtypes.AttributeValueMemberS{Value: "slack#T3"}},
			}); out != nil && out.Item != nil {
				t.Fatal("a refused write stored the item")
			}
		})
	}
}

// signedSlackRequest is a slash command for team T1 signed with secret.
func signedSlackRequest(secret string) events.APIGatewayProxyRequest {
	body := url.Values{"team_id": {"T1"}, "command": {"/spore"}, "text": {"help"}, "user_id": {"U1"},
		"channel_id": {"C1"}, "response_url": {"https://hooks.example.invalid/r"}}.Encode()
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("v0:" + ts + ":" + body))
	return events.APIGatewayProxyRequest{HTTPMethod: "POST", Path: "/slack", Body: body, Headers: map[string]string{
		"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": "v0=" + hex.EncodeToString(mac.Sum(nil)),
	}}
}

// The Slack request path verifies against the decrypted signing secret, still
// accepts a legacy plaintext one, and fails closed when it cannot decrypt.
func TestHandleSlackWebhook_SealedAndLegacySigningSecret(t *testing.T) {
	ctx := context.Background()
	secret := legacyCreds[credSigningSecret]

	reg := setupRegistry(t)
	if err := reg.PutWorkspace(ctx, &WorkspaceConfig{WorkspaceKey: "slack#T1", Platform: "slack", BotToken: "xoxb-x", SigningSecret: secret}); err != nil {
		t.Fatal(err)
	}
	if !isEncrypted(stringAttr(rawItem(t, reg, "slack#T1"), "signing_secret")) {
		t.Fatal("signing secret not stored sealed")
	}
	if _, err := handleSlackWebhook(ctx, reg, signedSlackRequest(secret)); err != nil {
		t.Fatalf("sealed secret: %v", err)
	}
	if _, err := handleSlackWebhook(ctx, reg, signedSlackRequest("not-the-secret")); err == nil {
		t.Fatal("a request signed with another secret verified")
	}
	reg.kms.(*fakeKMS).decryptErr = errors.New("AccessDeniedException")
	if _, err := handleSlackWebhook(ctx, reg, signedSlackRequest(secret)); err == nil || !strings.Contains(err.Error(), "signing secret unavailable") {
		t.Fatalf("undecryptable secret: %v; want a fail-closed error", err)
	}

	legacy := setupRegistry(t)
	putRaw(t, legacy, legacyItem("slack#T1"))
	legacy.kms = nil // a legacy item needs no KMS at all
	if _, err := handleSlackWebhook(ctx, legacy, signedSlackRequest(secret)); err != nil {
		t.Fatalf("legacy plaintext secret: %v", err)
	}
}

// The migration: one sweep re-seals every plaintext credential in place,
// leaves sealed values and non-workspace items alone, and a second sweep is a
// no-op.
func TestSealLegacyCredentials_MigratesInPlace(t *testing.T) {
	ctx := context.Background()
	reg := setupRegistry(t)
	putRaw(t, reg, legacyItem("slack#T1"))
	putRaw(t, reg, legacyItem("slack#T1#/spore"))
	if err := reg.PutWorkspace(ctx, legacyWorkspace("slack#T2")); err != nil { // already sealed
		t.Fatal(err)
	}
	before := rawItem(t, reg, "slack#T2")
	putRaw(t, reg, map[string]dynamodbtypes.AttributeValue{ // a connect code shares the table
		"workspace_key": &dynamodbtypes.AttributeValueMemberS{Value: "connect#ABC123"},
		"user_id":       &dynamodbtypes.AttributeValueMemberS{Value: "U1"},
	})
	extra := legacyItem("discord#G1") // non-credential attributes survive
	extra["public_key"] = &dynamodbtypes.AttributeValueMemberS{Value: "ed25519-public-key-fixture"}
	putRaw(t, reg, extra)

	st, err := reg.sealLegacyCredentials(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.sealed != 12 || st.items != 5 || st.changed != 0 || st.failed != 0 {
		t.Fatalf("sweep = %+v, want 12 values sealed in 5 items", st)
	}
	for _, key := range []string{"slack#T1", "slack#T1#/spore", "discord#G1"} {
		item := rawItem(t, reg, key)
		for _, f := range credFields() {
			stored := stringAttr(item, f.attribute)
			if !isEncrypted(stored) {
				t.Errorf("%s %s still %q", key, f, stored)
			}
			if got, err := reg.openCredential(ctx, f, key, stored); err != nil || got != legacyCreds[f] {
				t.Errorf("%s %s opens to %q, %v", key, f, got, err)
			}
		}
		if stringAttr(item, "platform") == "" {
			t.Errorf("%s lost its other attributes: %v", key, item)
		}
	}
	if stringAttr(rawItem(t, reg, "discord#G1"), "public_key") != "ed25519-public-key-fixture" {
		t.Error("the sweep rewrote a non-credential attribute")
	}
	if after := rawItem(t, reg, "slack#T2"); !maps.EqualFunc(before, after, func(a, b dynamodbtypes.AttributeValue) bool {
		return fmt.Sprint(a) == fmt.Sprint(b)
	}) {
		t.Error("the sweep rewrote an already sealed item")
	}
	if st, err := reg.sealLegacyCredentials(ctx); err != nil || st.sealed != 0 {
		t.Fatalf("second sweep = %+v, %v; want a no-op", st, err)
	}
}

// A value rewritten between the sweep's scan and its update (a token refresh)
// is not overwritten: the conditional update fails and the new value stays.
func TestSealLegacyCredentials_DoesNotClobberAConcurrentWrite(t *testing.T) {
	ctx := context.Background()
	reg := setupRegistry(t)
	putRaw(t, reg, legacyItem("slack#T1"))
	fk := reg.kms.(*fakeKMS)
	var once sync.Once
	fk.onEncrypt = func() {
		once.Do(func() { // a token refresh lands while the sweep seals
			_, err := reg.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
				TableName:        aws.String(reg.workspacesTable),
				Key:              map[string]dynamodbtypes.AttributeValue{"workspace_key": &dynamodbtypes.AttributeValueMemberS{Value: "slack#T1"}},
				UpdateExpression: aws.String("SET signing_secret = :v"),
				ExpressionAttributeValues: map[string]dynamodbtypes.AttributeValue{
					":v": &dynamodbtypes.AttributeValueMemberS{Value: "rotated-signing-secret-fixture"},
				},
			})
			if err != nil {
				t.Errorf("concurrent write: %v", err)
			}
		})
	}
	st, err := reg.sealLegacyCredentials(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.changed != 1 || st.sealed != 3 {
		t.Fatalf("sweep = %+v, want 1 changed meanwhile and 3 sealed", st)
	}
	if got := stringAttr(rawItem(t, reg, "slack#T1"), "signing_secret"); got != "rotated-signing-secret-fixture" {
		t.Fatalf("signing_secret = %q; the sweep overwrote the concurrent write", got)
	}
}

// Before the key exists the sweep writes nothing and is not an error.
func TestSealLegacyCredentials_NoKeyYetIsANoOp(t *testing.T) {
	reg := setupRegistry(t)
	putRaw(t, reg, legacyItem("slack#T1"))
	reg.kms = &fakeKMS{encryptErr: kmsNotFound()}
	st, err := reg.sealLegacyCredentials(context.Background())
	if err != nil || st.sealed != 0 {
		t.Fatalf("sweep = %+v, %v; want a no-op", st, err)
	}
	if stringAttr(rawItem(t, reg, "slack#T1"), "bot_token") != legacyCreds[credBotToken] {
		t.Fatal("the sweep changed an item before the key exists")
	}
}

// The scheduled event reaches the sweep through the Lambda handler.
func TestHandlerRoutesTheSweepTask(t *testing.T) {
	r := setupRegistry(t)
	putRaw(t, r, legacyItem("slack#T1"))
	orig := reg
	reg = r
	t.Cleanup(func() { reg = orig })
	ev, _ := json.Marshal(map[string]string{"spore_bot_task": sealLegacyCredentialsTask})
	if _, err := handler(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	if !isEncrypted(stringAttr(rawItem(t, r, "slack#T1"), "bot_token")) {
		t.Fatal("the scheduled task did not seal the item")
	}
	ev, _ = json.Marshal(map[string]string{"spore_bot_task": "something-else"})
	if _, err := handler(context.Background(), ev); err == nil {
		t.Fatal("an unknown task succeeded")
	}
}
