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
  self-invoke, `SpawnBotCrossAccount` assume, and scoped logs.
  `lambda/spore-bot/iam_gate_test.go` fails if the code makes a DynamoDB, Lambda
  or STS call this policy does not grant, or the policy grants a table the code
  never touches.
- `aws_lambda_function.spore_bot` — the function's **shape** (role, runtime,
  arm64, memory, timeout).
- `aws_lambda_function_url.spore_bot` + public invoke permission — the Function
  URL that Discord's interactions endpoint and instances' `spawn:notify-url`
  depend on. It is deterministic from function name + account + region, so it is
  preserved as long as the function keeps its name.

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

The role grants DynamoDB only on the default table names (`local.tables`) and
`PutItem` on `spore-sms-pending`. Overriding a `BOT_*_TABLE` variable to another
name needs a matching change to `local.tables`, or every call on that table is
AccessDenied.

## State

Local state, gitignored (`*.tfstate`). A remote backend (S3 + DynamoDB lock) is
a follow-up once more components are migrated. Never commit state or
`placeholder.zip`.

## How it was imported (runbook)

The live resources were created imperatively, then imported so Tofu adopts them
with **zero functional diff** (only additive `managedby=opentofu` tags):

```sh
export AWS_PROFILE=spore-host-infra
tofu init
tofu import aws_iam_role.spore_bot spore-bot-role
tofu import 'aws_iam_role_policy_attachment.basic_execution' 'spore-bot-role/arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
tofu import aws_iam_role_policy.spore_bot 'spore-bot-role:spore-bot-permissions'
tofu import aws_lambda_function.spore_bot spore-bot
tofu import aws_lambda_function_url.spore_bot spore-bot
tofu import aws_lambda_permission.url_public 'spore-bot/FunctionURLAllowPublicAccess'
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
