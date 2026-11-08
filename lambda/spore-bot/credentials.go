package main

// Workspace credentials at rest (#611, spore-host/spawn#868).
//
// The four credential attributes of a spore-bot-workspaces item are stored
// KMS-encrypted. spawn writes them too (its pkg/botsecret: `spawn notify
// workspace add`, the dashboard's Slack OAuth install and token refreshes), so
// the wire format below is a contract with that package and must not change
// on one side only:
//
//   - a sealed value is base64 of a KMS ciphertext blob;
//   - it is encrypted under alias/spore-bot-secrets (SPORE_BOT_SECRETS_KMS_KEY
//     overrides) with the encryption context
//     {"purpose": <the field's purpose>, "workspace_key": <the item's key>};
//   - a legacy (pre-encryption) item holds the plaintext, told apart with
//     isEncrypted, which is spawn's security.IsEncrypted;
//   - an empty value means the item holds no such credential.
//
// Rollout. The key is the switch: until alias/spore-bot-secrets exists, writes
// store the plaintext, the format every deployed reader handles, and log that
// once; once it exists, every write is sealed. Reads accept both formats. So
// the code can be deployed before or after spawn's, and the key is created
// last (infra/tofu/spore-bot, var.seal_workspace_credentials), once every
// reader can decrypt. The hourly sweep (sealLegacyCredentials) then re-seals
// the values already stored in plaintext, so no manual migration is needed.

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
)

// credField is one credential attribute of a workspace item.
type credField struct {
	attribute string // DynamoDB attribute; shared with spawn, must not change
	purpose   string // the "purpose" encryption-context value; IAM conditions on it
	label     string // for messages
}

// The credential fields. Attribute names and purposes match spawn's
// pkg/botsecret; spore-bot-role's KMS grants (infra/tofu/spore-bot) condition
// on the purposes.
var (
	credSigningSecret      = credField{"signing_secret", "spore-bot-signing-secret", "signing secret"}
	credBotToken           = credField{"bot_token", "spore-bot-bot-token", "bot token"}
	credRefreshToken       = credField{"refresh_token", "spore-bot-refresh-token", "refresh token"}
	credIncomingWebhookURL = credField{"incoming_webhook_url", "spore-bot-incoming-webhook-url", "incoming webhook URL"}
)

// credFields lists every credential field.
func credFields() []credField {
	return []credField{credSigningSecret, credBotToken, credRefreshToken, credIncomingWebhookURL}
}

func (f credField) String() string { return f.label }

// encryptionContext is the context f's value for workspaceKey is sealed and
// opened with.
func (f credField) encryptionContext(workspaceKey string) map[string]string {
	return map[string]string{"purpose": f.purpose, "workspace_key": workspaceKey}
}

// field returns a pointer to ws's value for f.
func (f credField) field(ws *WorkspaceConfig) *string {
	switch f {
	case credSigningSecret:
		return &ws.SigningSecret
	case credBotToken:
		return &ws.BotToken
	case credRefreshToken:
		return &ws.RefreshToken
	case credIncomingWebhookURL:
		return &ws.IncomingWebhookURL
	}
	panic("unknown credential field " + f.attribute)
}

// defaultSecretsKeyAlias names the KMS key that seals workspace credentials.
const defaultSecretsKeyAlias = "alias/spore-bot-secrets"

// kmsAPI is the part of the KMS client the credential code uses.
type kmsAPI interface {
	Encrypt(ctx context.Context, in *kms.EncryptInput, optFns ...func(*kms.Options)) (*kms.EncryptOutput, error)
	Decrypt(ctx context.Context, in *kms.DecryptInput, optFns ...func(*kms.Options)) (*kms.DecryptOutput, error)
}

// isEncrypted reports whether a stored value is a sealed one. It is spawn's
// security.IsEncrypted, which spawn's writers check every sealed value
// against: valid base64, at least 100 characters, and not URL-like. Legacy
// plaintexts fail it (a Slack signing secret is 32 characters, Slack tokens
// contain '-', webhook URLs contain "://").
func isEncrypted(value string) bool {
	if value == "" {
		return false
	}
	if _, err := base64.StdEncoding.DecodeString(value); err != nil {
		return false
	}
	if len(value) < 100 {
		return false
	}
	return !strings.Contains(value, "://") && !strings.HasPrefix(value, "http")
}

// notices remembers which once-only notices have been logged.
var notices sync.Map

// noticeOnce logs the first time key is seen in this execution environment.
func noticeOnce(key, format string, args ...any) {
	if _, seen := notices.LoadOrStore(key, true); !seen {
		logf(format, args...)
	}
}

// errKeyNotProvisioned means the default credentials key does not exist yet.
var errKeyNotProvisioned = errors.New("credentials key not provisioned")

// secretsKeyID is the KMS key the registry seals with.
func (r *Registry) secretsKeyID() string {
	if r.kmsKeyID != "" {
		return r.kmsKeyID
	}
	return defaultSecretsKeyAlias
}

// openCredential returns the plaintext of a stored value of f for the item
// keyed workspaceKey. A legacy plaintext value is returned as is, without a
// KMS call, and logged once per field; a sealed one is decrypted, and a
// decrypt failure is an error (the caller fails closed).
func (r *Registry) openCredential(ctx context.Context, f credField, workspaceKey, stored string) (string, error) {
	if !isEncrypted(stored) {
		if stored != "" {
			noticeOnce("legacy:"+f.attribute, "credentials: the %s of %s is stored unencrypted (logged once per field); the sweep re-seals such values once %s exists", f, workspaceKey, defaultSecretsKeyAlias)
		}
		return stored, nil
	}
	if r.kms == nil {
		return "", fmt.Errorf("%s for %s is encrypted and there is no KMS client to decrypt it", f, workspaceKey)
	}
	blob, err := base64.StdEncoding.DecodeString(stored)
	if err != nil {
		return "", fmt.Errorf("decode %s for %s: %w", f, workspaceKey, err)
	}
	out, err := r.kms.Decrypt(ctx, &kms.DecryptInput{
		CiphertextBlob:    blob,
		EncryptionContext: f.encryptionContext(workspaceKey),
	})
	if err != nil {
		return "", fmt.Errorf("decrypt %s for %s: %w", f, workspaceKey, err)
	}
	return string(out.Plaintext), nil
}

// sealCredential encrypts plaintext as f for the item keyed workspaceKey. An
// empty plaintext stays empty. When the default key does not exist yet it
// returns errKeyNotProvisioned (see the rollout note above); any other
// failure, including a missing key named with SPORE_BOT_SECRETS_KMS_KEY, is
// an error of its own.
func (r *Registry) sealCredential(ctx context.Context, f credField, workspaceKey, plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	if r.kms == nil {
		return "", fmt.Errorf("%s not stored: no KMS client to encrypt it with", f)
	}
	if workspaceKey == "" {
		return "", fmt.Errorf("%s not stored: empty workspace key", f)
	}
	keyID := r.secretsKeyID()
	out, err := r.kms.Encrypt(ctx, &kms.EncryptInput{
		KeyId:             aws.String(keyID),
		Plaintext:         []byte(plaintext),
		EncryptionContext: f.encryptionContext(workspaceKey),
	})
	var nf *kmstypes.NotFoundException
	if err != nil && keyID == defaultSecretsKeyAlias && errors.As(err, &nf) {
		return "", errKeyNotProvisioned
	}
	if err != nil {
		return "", fmt.Errorf("%s not stored: encrypt with KMS key %s: %w", f, keyID, err)
	}
	sealed := base64.StdEncoding.EncodeToString(out.CiphertextBlob)
	if !isEncrypted(sealed) {
		return "", fmt.Errorf("%s not stored: KMS returned a value that does not read as ciphertext", f)
	}
	return sealed, nil
}

// sealedWorkspace returns a copy of ws with every credential sealed for
// ws.WorkspaceKey. ws itself is not changed, so a caller can store the same
// plaintext under a second key (oauth.go writes two items; a value sealed for
// one key does not open under the other). Before the key exists the copy keeps
// the plaintext, logged once.
func (r *Registry) sealedWorkspace(ctx context.Context, ws *WorkspaceConfig) (WorkspaceConfig, error) {
	out := *ws
	for _, f := range credFields() {
		p := f.field(&out)
		sealed, err := r.sealCredential(ctx, f, out.WorkspaceKey, *p)
		if errors.Is(err, errKeyNotProvisioned) {
			noticeOnce("unsealed", "credentials: KMS key %s does not exist yet, so workspace credentials are stored unencrypted, as before; they are sealed once it exists", defaultSecretsKeyAlias)
			return *ws, nil
		}
		if err != nil {
			return WorkspaceConfig{}, fmt.Errorf("workspace %s: %w", out.WorkspaceKey, err)
		}
		*p = sealed
	}
	return out, nil
}

// sealLegacyCredentialsTask is the scheduled event's task value
// ({"spore_bot_task": "seal-legacy-credentials"}). spawn's self-host template
// (deployment/cloudformation/spore-bot.yaml) and infra/tofu/spore-bot send it.
const sealLegacyCredentialsTask = "seal-legacy-credentials"

// sweepStats counts what one sweep did.
type sweepStats struct {
	items, sealed, changed, failed int
}

// sealLegacyCredentials is the migration (#611): it re-seals every credential
// value in the workspaces table that is still stored in plaintext, whether
// written before encryption or by an older spawn CLI since. Each value is
// replaced by a conditional UpdateItem on that one attribute (SET attr =
// :sealed IF attr = :plain), so a value that changed since the scan (a token
// refresh, a re-install) is left alone rather than overwritten, and nothing
// else in the item is rewritten. Idempotent; a no-op once nothing is
// plaintext. Before the key exists it does nothing.
func (r *Registry) sealLegacyCredentials(ctx context.Context) (sweepStats, error) {
	var st sweepStats
	names := map[string]string{"#k": "workspace_key"}
	proj := []string{"#k"}
	for i, f := range credFields() {
		n := fmt.Sprintf("#c%d", i)
		names[n] = f.attribute
		proj = append(proj, n)
	}
	pages := dynamodb.NewScanPaginator(r.client, &dynamodb.ScanInput{
		TableName:                aws.String(r.workspacesTable),
		ProjectionExpression:     aws.String(strings.Join(proj, ", ")),
		ExpressionAttributeNames: names,
	})
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return st, fmt.Errorf("scan %s: %w", r.workspacesTable, err)
		}
		for _, item := range page.Items {
			st.items++
			key := stringAttr(item, "workspace_key")
			if key == "" {
				continue
			}
			for _, f := range credFields() {
				plain := stringAttr(item, f.attribute)
				if plain == "" || isEncrypted(plain) {
					continue
				}
				sealed, err := r.sealCredential(ctx, f, key, plain)
				if errors.Is(err, errKeyNotProvisioned) {
					logf("credential sweep: KMS key %s does not exist yet; nothing sealed", defaultSecretsKeyAlias)
					return st, nil
				}
				if err != nil {
					st.failed++
					logf("credential sweep: %s of %s: %v", f, key, err)
					continue
				}
				_, err = r.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
					TableName: aws.String(r.workspacesTable),
					Key: map[string]dynamodbtypes.AttributeValue{
						"workspace_key": &dynamodbtypes.AttributeValueMemberS{Value: key},
					},
					UpdateExpression:         aws.String("SET #a = :sealed"),
					ConditionExpression:      aws.String("#a = :plain"),
					ExpressionAttributeNames: map[string]string{"#a": f.attribute},
					ExpressionAttributeValues: map[string]dynamodbtypes.AttributeValue{
						":sealed": &dynamodbtypes.AttributeValueMemberS{Value: sealed},
						":plain":  &dynamodbtypes.AttributeValueMemberS{Value: plain},
					},
				})
				var ccf *dynamodbtypes.ConditionalCheckFailedException
				switch {
				case errors.As(err, &ccf):
					st.changed++ // rewritten since the scan; its writer sealed it, or the next sweep will
				case err != nil:
					st.failed++
					logf("credential sweep: store sealed %s of %s: %v", f, key, err)
				default:
					st.sealed++
				}
			}
		}
	}
	logf("credential sweep: %d items, %d values sealed, %d changed meanwhile, %d failed", st.items, st.sealed, st.changed, st.failed)
	if st.failed > 0 {
		return st, fmt.Errorf("credential sweep: %d values could not be sealed", st.failed)
	}
	return st, nil
}

// stringAttr returns item's string attribute name, or "".
func stringAttr(item map[string]dynamodbtypes.AttributeValue, name string) string {
	if v, ok := item[name].(*dynamodbtypes.AttributeValueMemberS); ok {
		return v.Value
	}
	return ""
}
