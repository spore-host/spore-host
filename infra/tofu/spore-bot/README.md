# spore-bot — OpenTofu module

The **first IaC in the umbrella**. It reconciles the (previously hand-deployed)
`spore-bot` Lambda and its dedicated execution role under OpenTofu, as the
reference pattern other hosted components follow. Everything else in the umbrella
is still imperative `setup-*.sh`; this is the start of migrating off that.

## What it manages

- `aws_iam_role.spore_bot` — **`spore-bot-role`**, least-privilege, dedicated.
  (Replaces the prior wrong setup where spore-bot ran under
  `prism-bot-PrismBotFunctionRole`.) DynamoDB RW on the three `spore-bot-*`
  tables, `PutItem` on `spore-sms-pending` (pending SMS replies, #576), Lambda
  self-invoke, `SpawnBotCrossAccount` assume, `kms:Encrypt`/`kms:Decrypt` on
  the workspace-credentials key per field (#611), and scoped logs.
  `lambda/spore-bot/iam_gate_test.go` fails if the code makes a DynamoDB, Lambda
  or STS call this policy does not grant, or the policy grants a table the code
  never touches.
- `aws_kms_key.spore_bot_secrets` — the key that seals workspace credentials
  (#611), and, once `seal_workspace_credentials` is true, its alias
  `alias/spore-bot-secrets` and, while the bot is in service
  (`public_endpoint_enabled`), the hourly migration sweep (EventBridge rule
  `spore-bot-seal-legacy-credentials`, its target and invoke permission). See
  [Workspace credentials](#workspace-credentials).
- `aws_lambda_function.spore_bot` — the function's **shape** (role, runtime,
  arm64, memory, timeout).
- `aws_lambda_function_url.spore_bot` + public invoke permission — the Function
  URL that Slack, Teams, Discord's interactions endpoint and instances'
  `spawn:notify-url` depend on. **Only while `public_endpoint_enabled` is
  true**, which it is not by default: see
  [Decommissioned for 1.0](#decommissioned-for-10).

## What it deliberately does NOT manage

- **Function code** — shipped from `lambda/spore-bot` with `make deploy`, which
  uploads the zip to S3, runs `aws lambda update-function-code`, waits, and
  checks the live `CodeSha256` against the zip it built. Tofu `ignore_changes`
  covers all code attributes so a deploy is never reverted.
- **Environment variables** — they hold secrets (OAuth, Teams, Discord public
  key). Tofu ignores `environment`, so secrets stay out of source and aren't
  clobbered. Set them with `aws lambda update-function-configuration` (or a
  secrets store later).

## Environment variables

Tofu ignores `environment`, so this table is the record of what the function
reads. It must list exactly the variables `lambda/spore-bot` reads:
`iam_gate_test.go` discovers them from the code and fails on any difference
(#576). `<PLATFORM>` is the first path segment of an OAuth route (`/<platform>/oauth`),
upper-cased; `<PROJECT>` is the slash command without its `/`, upper-cased.

| Variable | Purpose |
|---|---|
| `AWS_LAMBDA_FUNCTION_NAME` | Set by the Lambda runtime; used for the async self-invoke. Do not set it. |
| `DISCORD_PUBLIC_KEY` | Discord application Ed25519 public key (hex); verifies every Discord interaction. |
| `SLACK_SIGNING_SECRET` | App-level Slack signing secret, used when a workspace record stores none. |
| `<PLATFORM>_SLACK_CLIENT_ID` | Slack OAuth client id for that platform's app. |
| `<PLATFORM>_SLACK_CLIENT_SECRET` | Slack OAuth client secret for that platform's app. |
| `<PLATFORM>_OAUTH_SUCCESS_URL` | Where the OAuth callback redirects on completion. |
| `BOT_OAUTH_SECRET` | Signs OAuth `state`. Required: OAuth fails closed if unset or `change-me`. |
| `TEAMS_APP_ID` | Microsoft Teams bot app id. |
| `TEAMS_APP_SECRET` | Teams bot app secret (Bot Framework token). |
| `TEAMS_TENANT_ID` | Teams tenant id (Bot Framework token). |
| `TWILIO_ACCOUNT_SID` | Twilio account for SMS notifications. |
| `TWILIO_AUTH_TOKEN` | Twilio auth token. |
| `TWILIO_NUMBER_<PROJECT>` | Twilio sending number per project; SMS is skipped for a project without one. |
| `BOT_SLASH_COMMAND` | Slash command name; default `/spore`. |
| `BOT_CONNECT_CODE_TTL_HOURS` | Connect-code lifetime in hours; default 24. |
| `BOT_REGISTRY_TABLE` | Registry table; default `spore-bot-registry`. |
| `BOT_WORKSPACES_TABLE` | Workspaces table; default `spore-bot-workspaces`. |
| `BOT_AUDIT_TABLE` | Audit table; default `spore-bot-audit`. |
| `SPORE_BOT_SECRETS_KMS_KEY` | KMS key for workspace credentials; default `alias/spore-bot-secrets`. Leave unset: spore-bot-role is granted only this module's key, and a named key that does not exist fails every write. |

The role grants DynamoDB only on the default table names (`local.tables`) and
`PutItem` on `spore-sms-pending`. Overriding a `BOT_*_TABLE` variable to another
name needs a matching change to `local.tables`, or every call on that table is
AccessDenied.

## Workspace credentials

The `signing_secret`, `bot_token`, `refresh_token` and `incoming_webhook_url`
attributes of `spore-bot-workspaces` are stored KMS-encrypted (#611,
spore-host/spawn#868). Each value is sealed under `alias/spore-bot-secrets`
with the encryption context `{purpose: spore-bot-<field>, workspace_key: <item
key>}`, so it opens only as that field of that item. spawn's `pkg/botsecret`
writes and reads the same format.

**The alias is the switch.** Every writer (this bot, spawn's dashboard, the
spawn CLI) seals once `alias/spore-bot-secrets` exists and stores plaintext,
the old format, until then. Every reader accepts both. So the code of both
repos can ship in either order, and the alias is created last, by setting
`seal_workspace_credentials = true`, once every reader can decrypt:

1. this bot's code deployed (`make deploy`);
2. spawn's dashboard-api deployed, after re-running
   `lambda/dashboard-api/scripts/setup-dashboard-lambda-role.sh`, which grants
   `SpawnDashboardLambdaRole` the key (scoped to the alias);
3. the owner's spawn CLI upgraded (an older CLI cannot use a sealed bot token
   for `notify register --user <email>`).

Then flip the default in `main.tf` in a PR and `tofu apply`. The apply creates
the alias and the hourly sweep. The sweep re-seals every plaintext value in
place, each with a conditional update on that one attribute, so it never
overwrites a concurrent token refresh. It runs within the hour, and there is
no manual migration step. Leave it running while the bot is in service: it
also re-seals values an older spawn CLI writes in plaintext. It is removed
with the public endpoint ([Decommissioned for 1.0](#decommissioned-for-10)).

What spore-bot-role may do with the key (statements `SporeBotCredentialsEncrypt`
and `SporeBotCredentialsDecrypt`, both on the key ARN and conditioned on
`kms:EncryptionContext:purpose`):

| | signing secret | bot token | refresh token | webhook URL |
|---|---|---|---|---|
| `kms:Encrypt` | ✓ | ✓ | ✓ | ✓ |
| `kms:Decrypt` | ✓ | ✓ | — | ✓ |

`lambda/spore-bot/credentials_gate_test.go` fails if that table and the code
disagree.

**Do not set `seal_workspace_credentials` back to false** once sealed values
exist. Without the alias, every writer stores plaintext again, and
`SpawnDashboardLambdaRole`, whose grant is scoped to the alias, can no longer
decrypt the values already sealed. `prevent_destroy` guards the key itself;
to retire it, the workspaces must first be re-written unsealed.

## Decommissioned for 1.0

Chat integrations (Slack, Teams, Discord, spore-bot) are walled off for 1.0,
and the hosted spore-bot is decommissioned (#611). The runbook is on #611.
`public_endpoint_enabled` (default `false`) is the switch in this module:

| | `false` (decommissioned) | `true` (in service) |
|---|---|---|
| Function URL + `FunctionURLAllowPublicAccess` | removed | present |
| hourly sweep (rule, target, `AllowSealLegacyCredentialsSchedule`) | removed | present if `seal_workspace_credentials` |
| function, role, policy, KMS key, `alias/spore-bot-secrets` | kept | kept |

The sweep goes with the endpoint because, decommissioned, the table holds no
credentials, so there is nothing to seal, and the sweep is the only thing left
that invokes the function. With both gone, spore-bot has no invoker at all:
any later invocation, or any `kms:Decrypt` by `spore-bot-role`, is an anomaly.
The alias stays, so every writer still seals.

The tables (`spore-bot-registry`, `spore-bot-workspaces`, `spore-bot-audit`)
are not managed here. The first two were created by the `prism-bot`
CloudFormation stack; retire that stack only after setting `DeletionPolicy:
Retain` on both (#663).

Two invoke permissions on the function are not managed here either:
`spore-bot-admin-api` (the IAM-authorized HTTP API `spore-bot-admin`) and
`spore-bot-rest-admin-api` (for a REST API that no longer exists). The #611
runbook removes both.

**To bring the bot back after 1.0:** redeploy its credentials (env vars, a
Slack app install), set `public_endpoint_enabled = true`, `tofu apply`, and
point each platform at the URL the apply outputs (`function_url`). It may
differ from the old one.

## State

Remote, in the infra account's state bucket (`spore-bot/terraform.tfstate`),
locked with an S3 lock file. Migrated from the one local copy with
`tofu init -migrate-state` (#580). Credentials and the bucket:
[`../README.md`](../README.md). Never commit state or `placeholder.zip`.

## How it was imported (runbook)

The live resources were created imperatively, then imported so Tofu adopts them
with **zero functional diff** (only additive `managedby=opentofu` tags):

```sh
eval "$(aws configure export-credentials --profile spore-host-infra --format env)"
unset AWS_PROFILE; export AWS_REGION=us-east-1   # see ../README.md
tofu init
tofu import aws_iam_role.spore_bot spore-bot-role
tofu import 'aws_iam_role_policy_attachment.basic_execution' 'spore-bot-role/arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
tofu import aws_iam_role_policy.spore_bot 'spore-bot-role:spore-bot-permissions'
tofu import aws_lambda_function.spore_bot spore-bot
tofu import 'aws_lambda_function_url.spore_bot[0]' spore-bot       # with public_endpoint_enabled = true
tofu import 'aws_lambda_permission.url_public[0]' 'spore-bot/FunctionURLAllowPublicAccess'
tofu plan      # must be 0 to add / 0 to destroy (only tag changes)
tofu apply
```

## Day-to-day

- Change the role/permissions/function shape here → `tofu plan` → `tofu apply`.
- Ship new code: `cd ../../../lambda/spore-bot && make deploy`. It uses the
  `spore-host-infra` profile and fails unless that profile is account
  966362334030. `make verify` re-checks the live `CodeSha256` against the local
  `function.zip`.
- **Do not** re-create a `spore-bot` CloudFormation stack. This module owns the
  function. A stack that declares it would fight Tofu for ownership. Until #570,
  `make deploy` ended in an `aws cloudformation deploy` against a template that
  does not exist in this repo. It uploaded the zip and then failed, so the
  function code was never updated. CI now runs `scripts/check-deploy-paths.sh` to
  catch a deploy target that references a missing file.
- `tofu plan` should stay clean; a non-tag diff means something drifted
  out-of-band and is worth investigating.

## Cleanup (done 2026-06-14)

- ✅ Deleted the empty stuck `spore-bot` CloudFormation stack (was
  `REVIEW_IN_PROGRESS`, owned nothing).
- ✅ Removed the orphaned `SporeBotSelfInvoke` inline policy from the prism-bot
  role — spore-bot now has its own `spore-bot-role`, so the prism↔spore coupling
  is fully severed.
