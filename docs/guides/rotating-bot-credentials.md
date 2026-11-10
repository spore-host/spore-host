---
description: "How to replace every credential spore-bot holds (Slack signing secrets, bot and refresh tokens, webhook URLs, the Teams Azure Bot secret, Discord webhooks), so the new value is stored encrypted and the old one stops working."
---

# Rotating bot credentials

::: warning Experimental: not part of 1.0
Chat-platform integrations (Slack, Microsoft Teams, Discord and spore-bot) are
walled off for spore.host 1.0. **The hosted spore-bot is decommissioned as of
2026-11:** the spore.host Slack apps, the hosted Teams bot and its public
endpoints are being retired, so there is nothing hosted to install or connect.
The code is kept, and you can still self-host it, but it is experimental and
unsupported, and it may change or be removed. See
[spore-host#611](https://github.com/spore-host/spore-host/issues/611).
:::

This guide replaces the credentials spore-bot uses for Slack, Microsoft Teams
and Discord. For each one it covers:

- where to get a new value;
- how to store it so it is encrypted at rest;
- the order that keeps the bot answering while you change it;
- how to check the result without printing a secret;
- how to make sure the old value no longer works.

It is written for operators of a
[self-hosted spore-bot](/spore-bot-self-hosting).

::: tip If your workspace had the hosted spore.host Slack or Teams app
The hosted apps are being removed as part of the decommission, which revokes
the tokens and the channel webhooks spore.host stored for your workspace. If the
app is still listed in your workspace, remove it (in Slack: **Tools & settings →
Manage apps → Installed Apps** → the app → **Remove App**). There is nothing to
reinstall.
:::

## When to rotate

- A credential was, or may have been, readable by someone who should not have
  it: a leaked log, a shared screen, a departed admin, or a security advisory.
- A credential was stored in plaintext and is now sealed. Sealing protects the
  values written after it. A value that sat in plaintext stays exposed in every
  copy of it: point-in-time recovery, backups, exports and terminal scrollback.
  Only rotation makes those copies worthless.
- On a schedule. Azure client secrets expire anyway (24 months at most).

## Where each credential lives

spore-bot keeps per-workspace credentials in the `spore-bot-workspaces`
DynamoDB table. Four attributes are **sealed**: KMS-encrypted under
`alias/spore-bot-secrets`, with the encryption context
`{purpose: <field>, workspace_key: <item key>}`. A sealed value is base64 of
at least 100 characters, and it opens only as that field of that item. The rest
of spore-bot's secrets are in its Lambda environment.

| Credential | Stored in | Used for |
|---|---|---|
| Slack **signing secret** (one per Slack app) | `signing_secret` on that app's workspace items (`slack#<team>#<app-id>`, `slack#<team>#/<command>`, and the legacy `slack#<team>` if it holds one). As a fallback, spore-bot's `SLACK_SIGNING_SECRET` env var. Where spawn's dashboard installs the app, also the Secrets Manager secret its `SLACK_SECRETS_ARN` names (`signing_secret` field) | Verifying that a slash command came from Slack |
| Slack **bot token** | `bot_token` on the workspace items | DMs; resolving `--user <email>` |
| Slack **refresh token** (apps with token rotation) | `refresh_token` on the workspace items | Minting new bot tokens. Needs the app's client secret too |
| Slack **incoming webhook URL** | `incoming_webhook_url` on the workspace items | Posting notifications to the channel picked at install |
| Slack **client secret** | spore-bot env `<PLATFORM>_SLACK_CLIENT_SECRET`; the dashboard's Secrets Manager secret (`client_secret` field) | The OAuth install and token refresh |
| Teams **Azure Bot client secret** | spore-bot env `TEAMS_APP_SECRET`. A tenant registered with `--bot-token` (as [Teams Setup](/guides/teams-setup) step 3 says) also has a copy in that tenant's `bot_token` | Getting Bot Framework tokens to send replies and DMs |
| Teams **signing secret** | Nothing. spore-bot verifies Teams requests only with Bot Framework tokens, and refuses to store a `signing_secret` on `teams#<tenant>`. If an item still has one, [remove it](/guides/teams-setup#step-3-connect-your-workspace) | Nothing |
| Discord **channel webhook URL** | `incoming_webhook_url` on `discord#<guild>` | Posting notification embeds |
| Discord **application public key** | `public_key` on `discord#<guild>`; env `DISCORD_PUBLIC_KEY` | Verifying interactions. **Public, not a secret**; it changes only if you recreate the application |
| Discord **bot token** | Not stored by spore-bot, unless you passed it as `--bot-token` | Registering slash commands (`scripts/register-discord-commands.sh`) |
| `BOT_OAUTH_SECRET` | spore-bot env | Signing the OAuth `state` parameter |

Before you start, list what your table actually holds. Use
[`ws_lengths`](#set-up-the-helpers): it prints only keys and lengths.

## Ground rules

- **Never print a secret.** Paste new values at a hidden prompt (the helpers
  below do this), and pass them on stdin, never as command-line arguments. Look
  at stored values only by length. Don't run `aws secretsmanager
  get-secret-value`, `aws kms decrypt` or `aws lambda get-function-configuration`
  without a `--query` that leaves the secret out.
- **Write sealed values.** Each step below writes through a path that encrypts.
  The hourly `seal-legacy-credentials` sweep also seals any plaintext it finds,
  but a plaintext write still leaves a plaintext copy in point-in-time recovery.
- **A Slack signing secret changes at once.** When you regenerate it, Slack signs
  every following request with the new one, and spore-bot accepts only one
  secret per item. Requests are rejected from that click until the new value is
  stored. Have the commands ready, and run them right after you click.
- **`aws lambda update-function-configuration --environment` replaces the whole
  variable set**, and its response prints every value. Use `lambda_env_set`
  below, which merges in one variable and prints only the update status.
- **Self-hosted with the CloudFormation template?** The stack owns the
  function's environment. Change a variable with a stack update
  (`stack_param_set` below), or the next stack update reverts it.

## Set up the helpers

Run these in **bash**, not zsh (`read -s -p` is bash syntax). They need the AWS
CLI v2 and `jq`. Set the profile, region, table and key for your deployment:

```bash
bash
export AWS_PROFILE=<infra-account-profile> REGION=us-east-1
export WS_TABLE=spore-bot-workspaces KEY=alias/spore-bot-secrets

# ask_secret LABEL: reads a value at a hidden prompt into $NEW. forget_secret clears it.
ask_secret() { IFS= read -rs -p "$1 (input hidden): " NEW; echo >&2; [ -n "$NEW" ] || { echo "empty" >&2; return 1; }; }
forget_secret() { unset NEW; }

_purpose() { case "$1" in
  signing_secret) echo spore-bot-signing-secret ;; bot_token) echo spore-bot-bot-token ;;
  refresh_token) echo spore-bot-refresh-token ;; incoming_webhook_url) echo spore-bot-incoming-webhook-url ;;
  *) echo "unknown attribute $1" >&2; return 1 ;; esac; }
_ctx() { jq -cn --arg p "$1" --arg k "$2" '{purpose: $p, workspace_key: $k}'; }
_key() { jq -cn --arg k "$1" '{workspace_key: {S: $k}}'; }
_store() {  # KEY ATTR CIPHERTEXT: sets one attribute of an existing item
  aws dynamodb update-item --region "$REGION" --table-name "$WS_TABLE" --key "$(_key "$1")" \
    --update-expression 'SET #a = :c' --condition-expression 'attribute_exists(workspace_key)' \
    --expression-attribute-names "$(jq -cn --arg a "$2" '{"#a": $a}')" \
    --expression-attribute-values "$(jq -cn --arg c "$3" '{":c": {S: $c}}')"; }
_stored() {  # KEY ATTR: the stored (sealed) value, for piping only
  aws dynamodb get-item --region "$REGION" --table-name "$WS_TABLE" --key "$(_key "$1")" \
    --projection-expression '#a' --expression-attribute-names "$(jq -cn --arg a "$2" '{"#a": $a}')" \
    --output json | jq -er --arg a "$2" '.Item[$a].S'; }

# ws_lengths: every workspace item, with the length of each credential (0 = none). Never values.
ws_lengths() {
  aws dynamodb scan --region "$REGION" --table-name "$WS_TABLE" --output json \
    --projection-expression 'workspace_key, platform, app_id, signing_secret, bot_token, refresh_token, incoming_webhook_url, public_key' \
  | jq -r '.Items[] | select(.workspace_key.S | startswith("connect#") | not)
      | [.workspace_key.S, (.platform.S // "-"), (.app_id.S // "-")]
        + ([ "signing_secret", "bot_token", "refresh_token", "incoming_webhook_url", "public_key" ]
           as $f | [ $f[] as $a | "\($a)=\((.[$a].S // "") | length)" ])
      | @tsv' | sort; }

# seal_put KEY ATTR: seals $NEW for that item and attribute and stores it in place.
seal_put() {
  local purpose ct; purpose=$(_purpose "$2") || return 1
  ct=$(printf %s "$NEW" | aws kms encrypt --region "$REGION" --key-id "$KEY" \
         --encryption-context "$(_ctx "$purpose" "$1")" --plaintext fileb:///dev/stdin \
         --query CiphertextBlob --output text) || return 1
  [ ${#ct} -ge 100 ] || { echo "encrypt failed" >&2; return 1; }
  _store "$1" "$2" "$ct" && echo "sealed $2 on $1 (${#ct} chars)"; }

# reseal_copy SRC DST ATTR: copies a sealed credential from item SRC to item DST,
# re-sealed for DST. The plaintext only passes through pipes.
reseal_copy() {
  local purpose ct; purpose=$(_purpose "$3") || return 1
  ct=$(set -o pipefail; _stored "$1" "$3" | base64 --decode \
       | aws kms decrypt --region "$REGION" --ciphertext-blob fileb:///dev/stdin \
           --encryption-context "$(_ctx "$purpose" "$1")" --query Plaintext --output text | base64 --decode \
       | aws kms encrypt --region "$REGION" --key-id "$KEY" --plaintext fileb:///dev/stdin \
           --encryption-context "$(_ctx "$purpose" "$2")" --query CiphertextBlob --output text) || { echo "copy failed" >&2; return 1; }
  [ ${#ct} -ge 100 ] || { echo "copy failed" >&2; return 1; }
  _store "$2" "$3" "$ct" && echo "copied $3: $1 -> $2 (${#ct} chars)"; }

# check_binding KEY ATTR: proves the stored value opens as that field of that item.
# Prints only the KMS key ARN (an error means it does not open).
check_binding() {
  local purpose; purpose=$(_purpose "$2") || return 1
  (set -o pipefail; _stored "$1" "$2" | base64 --decode \
    | aws kms decrypt --region "$REGION" --ciphertext-blob fileb:///dev/stdin \
        --encryption-context "$(_ctx "$purpose" "$1")" --query KeyId --output text); }

# lambda_env_set FUNCTION VAR: sets one env var to $NEW and keeps the others. Prints only the status.
lambda_env_set() {
  (set -o pipefail
   aws lambda get-function-configuration --region "$REGION" --function-name "$1" --query Environment --output json \
   | V="$NEW" jq -c --arg n "$2" '{Variables: ((.Variables // {}) + {($n): env.V})}' \
   | aws lambda update-function-configuration --region "$REGION" --function-name "$1" \
       --environment file:///dev/stdin --query '{State: State, LastUpdateStatus: LastUpdateStatus}' --output json) \
  && aws lambda wait function-updated --region "$REGION" --function-name "$1" && echo "updated $2 on $1"; }

# sm_set_field SECRET_ID FIELD: sets one field of a JSON Secrets Manager secret to $NEW.
sm_set_field() {
  (set -o pipefail
   aws secretsmanager get-secret-value --region "$REGION" --secret-id "$1" --query SecretString --output text \
   | V="$NEW" jq -c --arg f "$2" '.[$f] = env.V' \
   | aws secretsmanager put-secret-value --region "$REGION" --secret-id "$1" \
       --secret-string file:///dev/stdin --query VersionId --output text); }

# stack_param_set STACK PARAM: CloudFormation stack update that sets one NoEcho parameter
# to $NEW and keeps every other parameter (self-hosted stacks only).
stack_param_set() {
  (set -o pipefail
   aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
       --query 'Stacks[0].Parameters[].ParameterKey' --output json \
   | V="$NEW" jq -c --arg p "$2" '[.[] | if . == $p then {ParameterKey: ., ParameterValue: env.V}
                                         else {ParameterKey: ., UsePreviousValue: true} end]' \
   | aws cloudformation update-stack --region "$REGION" --stack-name "$1" --use-previous-template \
       --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --parameters file:///dev/stdin --query StackId --output text) \
  && aws cloudformation wait stack-update-complete --region "$REGION" --stack-name "$1" && echo "updated $2 on $1"; }

# recent_decrypts MINUTES: KMS Decrypt calls on workspace credentials in the last N minutes
# (from CloudTrail, which lags by up to ~15 minutes): time, caller, field, item, result.
recent_decrypts() {
  local since; since=$(date -u -v-"$1"M +%FT%TZ 2>/dev/null || date -u -d "-$1 min" +%FT%TZ)
  aws cloudtrail lookup-events --region "$REGION" --start-time "$since" --max-results 50 --output json \
      --lookup-attributes AttributeKey=EventName,AttributeValue=Decrypt \
  | jq -r '.Events[].CloudTrailEvent | fromjson
      | select(.requestParameters.encryptionContext.workspace_key? != null)
      | [.eventTime, (.userIdentity.arn | split("/") | .[-2:] | join("/")),
         .requestParameters.encryptionContext.purpose, .requestParameters.encryptionContext.workspace_key,
         (.errorCode // "ok")] | @tsv'; }
```

Run `ws_lengths` now and keep the output. It is your list of items to rotate.

## Slack: signing secret

A Slack app has one signing secret, and every workspace item of that app holds a
copy. Rotate per **app**, not per item.

1. Open [api.slack.com/apps](https://api.slack.com/apps) → your app →
   **Settings → Basic Information → App Credentials**. Don't click anything yet.
2. In the bash session above, find the app's items in `ws_lengths`. Those are the
   items whose `app_id` column is the app's ID (`A…`) and whose
   `signing_secret` is non-zero. Typically that is `slack#<team>#<app-id>` and
   `slack#<team>#/<command>`.
3. Click **Regenerate** next to **Signing Secret**, then **Show**, and copy it.
   From this moment Slack signs with the new secret ([Slack: verifying
   requests](https://docs.slack.dev/authentication/verifying-requests-from-slack)).
4. Immediately store it on each of the app's items. Do the command-scoped one
   first, because it is the one slash commands are verified with:

   ```bash
   ask_secret "new signing secret"
   seal_put 'slack#<team>#/<command>' signing_secret
   seal_put 'slack#<team>#<app-id>'   signing_secret
   ```

5. If spawn's dashboard installs this app (hosted spore.host: the `/spore` app),
   also update its Secrets Manager copy. The dashboard keeps the value it read
   until its execution environments are replaced, so update the function's
   configuration to recycle them:

   ```bash
   sm_set_field spore/dashboard-api/slack signing_secret
   aws lambda update-function-configuration --region "$REGION" --function-name spawn-dashboard-api \
     --description "Spawn Dashboard API - read-only instance viewer (signing secret rotated $(date -u +%F))" \
     --query LastUpdateStatus --output text
   ```

6. If you set spore-bot's `SLACK_SIGNING_SECRET` fallback for this app, update it:
   `lambda_env_set spore-bot SLACK_SIGNING_SECRET`, or on a CloudFormation
   stack, `stack_param_set spore-bot SlackSigningSecret`.
7. `forget_secret`, then [verify](#verify).

The old signing secret is dead as soon as you regenerate it. There is nothing to
revoke.

::: warning A reinstall through spore-bot's own OAuth clears the signing secret
`/<platform>/oauth` on the spore-bot function URL rewrites both of that app's
items without a signing secret, so slash commands fail closed until you run
step 4 again. Rotate the signing secret **after** any reinstall (see
[spore-host#659](https://github.com/spore-host/spore-host/issues/659)).
:::

## Slack: bot token, refresh token and webhook URL

These are tied to the app's **installation** in a workspace. Removing the app
revokes every token of that installation
([Slack: token rotation](https://docs.slack.dev/authentication/using-token-rotation)).
Its incoming webhooks belong to the installation too; step 6 checks they are
gone. Reinstalling stores new ones, sealed.

1. **Remove the app from the workspace.** In Slack, click the workspace name →
   **Tools & settings → Manage apps → Installed Apps** → the app → **App
   Details → Configuration → Remove App**
   ([Slack help](https://slack.com/help/articles/360003125231-Remove-apps-and-custom-integrations-from-your-workspace)).
   The slash command stops working until step 2.
2. **Reinstall through spore.host's OAuth URL**, not the **Install App** button
   in the app settings. Slack's own button gives you the token but never stores
   it in spore.host. Use whichever URL your deployment's install flow uses:
   - spawn's dashboard: `https://<dashboard-api-host>/api/slack/oauth`;
   - spore-bot's own flow: `https://<spore-bot-function-url>/<platform>/oauth`.

   Pick the notification channel when Slack asks.
3. Run `ws_lengths`. The installed items now have a new `bot_token`,
   `refresh_token` (with token rotation on) and `incoming_webhook_url`, each of
   at least 100 characters.
4. **Bring every other item of the app up to date.** The two install flows
   write different items:
   - spore-bot's flow writes both `slack#<team>#<app-id>` and
     `slack#<team>#/<command>`;
   - the dashboard's flow writes only `slack#<team>#<app-id>`.

   A `slack#<team>#/<command>` item that the install did not rewrite still holds
   the old, now-revoked values, and notifications read it first. Copy the new
   values across:

   ```bash
   for a in bot_token refresh_token incoming_webhook_url; do
     reseal_copy 'slack#<team>#<app-id>' 'slack#<team>#/<command>' "$a"
   done
   ```

5. A spore-bot reinstall clears the signing secret, so follow
   [Slack: signing secret](#slack-signing-secret) now.
6. In the app settings, under **Features → Incoming Webhooks**, check that
   **Webhook URLs for Your Workspace** lists only the new URL. Remove any
   other URL there.

Optionally, regenerate the app's **Client Secret** too, from the same App
Credentials panel. Store it with `sm_set_field <dashboard-secret> client_secret`
or `lambda_env_set spore-bot <PLATFORM>_SLACK_CLIENT_SECRET`. Slack keeps the
previous client secret valid for 24 hours. Do this when the client secret
itself may have been exposed: a stolen refresh token is only usable together
with it.

## Teams: Azure Bot client secret

The secret spore-bot really uses is the `TEAMS_APP_SECRET` env var.

1. In the [Azure portal](https://portal.azure.com), open the **Azure Bot**
   resource → **Settings → Configuration**. Next to **Microsoft App ID**, select
   **Manage Password**. This opens the app registration's **Certificates &
   secrets** page.
2. **Client secrets → New client secret**. Give it a description (for example
   `spore-bot 2026-11`) and an expiry (Microsoft recommends under 12 months),
   then select **Add**. Copy the **Value** now: it is never shown again
   ([Microsoft: add a client secret](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials)).
   The old secret keeps working until you delete it, so there is no downtime.
3. Store it:

   ```bash
   ask_secret "new Azure Bot client secret"
   lambda_env_set spore-bot TEAMS_APP_SECRET           # Tofu-managed or hand-deployed function
   # stack_param_set spore-bot TeamsAppSecret          # CloudFormation stack instead
   ```

4. If a tenant item has a `bot_token` (`ws_lengths` shows `teams#<tenant>` with
   `bot_token` > 0), it is a copy of the old secret. Replace it with
   `spawn notify workspace add --platform teams --workspace-id <tenant> --bot-token <new>`.
   This rewrites the whole item: pass every flag you registered it with. Run it
   from a shell that keeps no history (`set +o history` in bash). spore-bot uses
   that copy only to know the tenant exists (see
   [spore-host#660](https://github.com/spore-host/spore-host/issues/660)).
5. `forget_secret`, then [verify](#verify) with a Teams message.
6. **Delete the old secret.** Back in **Certificates & secrets → Client
   secrets**, delete every secret except the one you created in step 2. Bot
   Framework tokens issued with the old secret stay valid until they expire,
   within the hour.

A Teams workspace has no signing secret to rotate: spore-bot accepts Teams
requests only with Bot Framework tokens. If `ws_lengths` shows a
`signing_secret` on `teams#<tenant>`, it is unused; remove it as
[Teams Setup](/guides/teams-setup#step-3-connect-your-workspace) describes, and
rotate the Azure Bot client secret as above.

## Discord

- **Channel webhook URL:** in Discord, open **Edit Channel → Integrations →
  Webhooks**, create a new webhook and copy its URL, then **Delete Webhook** on
  the old one. Store it with `ask_secret` and
  `seal_put 'discord#<guild>' incoming_webhook_url`.
- **Bot token:** if you passed one as `--bot-token`, reset it in the
  [Developer Portal](https://discord.com/developers/applications) → your
  application → **Bot → Reset Token**, and store it with
  `seal_put 'discord#<guild>' bot_token`. spore-bot does not use it for
  notifications.
- **Public key:** public by design. Nothing to rotate.

## Verify

Do all of these, and none of them prints a secret:

1. **Sealed:** `ws_lengths` shows every non-zero credential at 100 characters or
   more. A Slack signing secret in plaintext is 32 characters, and a webhook URL
   under 100.
2. **Bound to the right item:** `check_binding '<key>' <attribute>` prints the
   ARN of the key `alias/spore-bot-secrets` points to, for each value you wrote. An
   `InvalidCiphertextException` means the value was sealed for another item or
   field.
3. **Round trip:**
   - Slack: run `/<command> help` in the workspace. A reply means the signing
     secret verified.
   - Teams: send the bot `help` in a chat. A reply means `TEAMS_APP_SECRET`
     works, because the reply is sent with a token obtained with it.
4. **The bot used the new values:** `recent_decrypts 30` lists spore-bot-role's
   Decrypt calls with each field, item and `ok`. CloudTrail lags by up to about
   15 minutes.
5. **No failures:**

   ```bash
   aws logs filter-log-events --region "$REGION" --log-group-name /aws/lambda/spore-bot \
     --start-time $(( ($(date +%s) - 3600) * 1000 )) \
     --filter-pattern '?"verification failed" ?"unavailable" ?"token error" ?"invalid_auth"' \
     --query 'events[].message' --output text
   ```

   prints nothing.

## Known gaps

- [spore-host#659](https://github.com/spore-host/spore-host/issues/659): no
  supported command rotates a Slack credential in place on every item of an
  app. Until then, this guide writes single attributes with `seal_put` and
  `reseal_copy`.
- [spore-host#660](https://github.com/spore-host/spore-host/issues/660): the Teams
  secret lives only in the Lambda environment, and a Teams tenant needs a
  `bot_token` just to receive notifications.
- [spore-host#661](https://github.com/spore-host/spore-host/issues/661): spore-bot
  does not refresh rotating Slack bot tokens, so DMs stop 12 hours after an
  install.
