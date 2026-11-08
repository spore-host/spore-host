###############################################################################
# spore-bot — OpenTofu reference module (spore-host/spawn#2 follow-up).
#
# This is the FIRST IaC in the umbrella: it reconciles the hand-deployed
# spore-bot Lambda (and its dedicated execution role) under OpenTofu, as the
# pattern other components follow later. The live resources were created
# imperatively; this module is `tofu import`ed onto them and must `tofu plan`
# to ZERO diff before it owns anything (see README.md).
#
# Deliberately NOT managed here (left to existing flows / kept out of source):
#   - Function CODE: deployed via `make deploy` / update-function-code. Tofu
#     ignores code attributes so it never reverts a deploy.
#   - Function ENV vars: contain secrets (OAuth, Teams, Discord key). Tofu
#     ignores `environment` so secrets stay out of source and aren't clobbered.
###############################################################################

terraform {
  # >= 1.10 for the S3 backend's native lock file (use_lockfile).
  required_version = ">= 1.10"

  # State lives in the infra account's state bucket, one key per root, locked
  # with an S3 lock file (#580). Create the bucket once with
  # infra/tofu/state-bucket.sh. The backend uses the ambient credentials (see
  # README), never var.aws_profile: backend blocks cannot read variables.
  backend "s3" {
    bucket       = "spore-host-tofu-state-966362334030"
    key          = "spore-bot/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
  # Account 966362334030. Default: the ambient credentials exported from the
  # spore-host-infra profile (see ../README.md); -var aws_profile=... overrides.
  profile = var.aws_profile != "" ? var.aws_profile : null
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "seal_workspace_credentials" {
  type = bool
  # The switch for encrypting workspace credentials at rest (#611,
  # spore-host/spawn#868). Every writer seals with alias/spore-bot-secrets once
  # the alias exists, and stores plaintext (the old format) until then. So the
  # alias, and the hourly sweep that re-seals existing plaintext, are created
  # only when this is true, and it must become true only after EVERY reader can
  # decrypt: this bot's code (make deploy) AND spawn's dashboard-api (with its
  # role re-provisioned) AND the owner's spawn CLI. The key and the grants below
  # exist either way; without the alias nothing uses them. See README.md
  # "Workspace credentials". Never set it back to false once sealed values
  # exist: the alias is what every reader and writer resolves.
  default = false
}

variable "aws_profile" {
  type = string
  # Empty: use the ambient credentials (AWS_* from `aws configure
  # export-credentials`, see README). The provider cannot itself resolve a
  # profile whose source_profile uses `aws login` (#580).
  default = ""
}

locals {
  account_id = "966362334030"
  fn_name    = "spore-bot"
  tables = {
    registry   = "spore-bot-registry"
    workspaces = "spore-bot-workspaces"
    audit      = "spore-bot-audit"
  }
  # Written by spore-bot (PutItem only) so an SMS reply can be matched to the
  # instance it answers (lambda/spore-bot/sms_notify.go). Not one of the bot's
  # own tables, so it is not in local.tables and gets only the action the code
  # performs (#576).
  sms_pending_table = "spore-sms-pending"
  table_arns = flatten([
    for t in values(local.tables) : [
      "arn:aws:dynamodb:${var.region}:${local.account_id}:table/${t}",
      "arn:aws:dynamodb:${var.region}:${local.account_id}:table/${t}/index/*",
    ]
  ])
  # The encryption-context purposes of the workspace credential fields, as in
  # lambda/spore-bot/credentials.go and spawn's pkg/botsecret.
  credential_purposes_encrypt = [
    "spore-bot-signing-secret",
    "spore-bot-bot-token",
    "spore-bot-refresh-token",
    "spore-bot-incoming-webhook-url",
  ]
  credential_purposes_decrypt = [
    "spore-bot-signing-secret",
    "spore-bot-bot-token",
    "spore-bot-incoming-webhook-url",
  ]
  common_tags = {
    project   = "spore-host"
    component = "spore-bot"
    managedby = "opentofu"
  }
}

# ── Execution role (dedicated — decoupled from prism-bot) ────────────────────

resource "aws_iam_role" "spore_bot" {
  name        = "spore-bot-role"
  description = "Execution role for the spore.host spore-bot Lambda (decoupled from prism-bot, #2/infra)"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "basic_execution" {
  role       = aws_iam_role.spore_bot.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "spore_bot" {
  name = "spore-bot-permissions"
  role = aws_iam_role.spore_bot.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SporeBotTables"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:DescribeTable", "dynamodb:ConditionCheckItem"]
        Resource = local.table_arns
      },
      {
        Sid      = "SporeBotSmsPendingWrite"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = "arn:aws:dynamodb:${var.region}:${local.account_id}:table/${local.sms_pending_table}"
      },
      {
        Sid      = "SporeBotSelfInvoke"
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = "arn:aws:lambda:${var.region}:${local.account_id}:function:${local.fn_name}"
      },
      {
        # The account in this ARN is intentionally a wildcard: SpawnBotCrossAccount
        # roles live in USERS' own AWS accounts (the bot assumes into them to run
        # EC2 ops for /spore stop etc.), so the account id genuinely cannot be
        # pinned. The role name is fixed, bounding the scope.
        Sid    = "SporeBotCrossAccountEC2"
        Effect = "Allow"
        # nosemgrep: terraform.lang.security.iam.no-iam-creds-exposure.no-iam-creds-exposure
        Action   = "sts:AssumeRole"
        Resource = "arn:aws:iam::*:role/SpawnBotCrossAccount"
      },
      {
        # Workspace credentials (credentials.go): the OAuth install and the
        # admin API write all four fields, and the sweep re-seals any of them,
        # so the bot encrypts every purpose.
        Sid      = "SporeBotCredentialsEncrypt"
        Effect   = "Allow"
        Action   = ["kms:Encrypt"]
        Resource = aws_kms_key.spore_bot_secrets.arn
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:purpose" = local.credential_purposes_encrypt
          }
        }
      },
      {
        # It decrypts only what it uses: the signing secret to verify requests,
        # the bot token to DM, the webhook URL to post. It never refreshes
        # tokens, so it cannot open a refresh token.
        Sid      = "SporeBotCredentialsDecrypt"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.spore_bot_secrets.arn
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:purpose" = local.credential_purposes_decrypt
          }
        }
      },
      {
        Sid      = "SporeBotLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/${local.fn_name}*"
      },
      {
        Sid      = "SporeBotXRay"
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
        Resource = "*"
      }
    ]
  })
}

# ── Workspace credentials key (#611, spore-host/spawn#868) ───────────────────
# Seals the signing_secret, bot_token, refresh_token and incoming_webhook_url of
# every spore-bot-workspaces item. Users: this bot (spore-bot-role, above), and
# spawn's dashboard Lambdas (SpawnDashboardLambdaRole, whose grant spawn's
# lambda/dashboard-api/scripts/setup-dashboard-lambda-role.sh writes, scoped to
# this alias), and an operator running `spawn notify workspace add` with admin
# credentials in this account. The key policy delegates to IAM in this account
# only; no other account is named anywhere.
#
# prevent_destroy: deleting the key makes every sealed credential unreadable.
# To retire it, re-key the workspaces in plaintext first (remove the alias, run
# the writers), then remove prevent_destroy and destroy, which schedules
# deletion after the 7-day window.

resource "aws_kms_key" "spore_bot_secrets" {
  description             = "spore-bot workspace credentials (spore-bot-workspaces signing_secret, bot_token, refresh_token, incoming_webhook_url)"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "EnableIAMPoliciesInThisAccount"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })
  tags = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

# The switch (var.seal_workspace_credentials): writers seal once this exists.
resource "aws_kms_alias" "spore_bot_secrets" {
  count         = var.seal_workspace_credentials ? 1 : 0
  name          = "alias/spore-bot-secrets"
  target_key_id = aws_kms_key.spore_bot_secrets.key_id
}

# The migration: an hourly sweep that re-seals, in place, every credential still
# stored in plaintext (items written before #611, and by an older spawn CLI
# since). A no-op once nothing is plaintext. Created with the alias, so it never
# runs before the key it seals with exists.
resource "aws_cloudwatch_event_rule" "seal_legacy_credentials" {
  count               = var.seal_workspace_credentials ? 1 : 0
  name                = "spore-bot-seal-legacy-credentials"
  description         = "spore-bot: re-seal workspace credentials still stored in plaintext (#611)"
  schedule_expression = "rate(1 hour)"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "seal_legacy_credentials" {
  count = var.seal_workspace_credentials ? 1 : 0
  rule  = aws_cloudwatch_event_rule.seal_legacy_credentials[0].name
  arn   = aws_lambda_function.spore_bot.arn
  # lambda/spore-bot main.go routes on this (sealLegacyCredentialsTask).
  input = jsonencode({ spore_bot_task = "seal-legacy-credentials" })
}

resource "aws_lambda_permission" "seal_legacy_credentials" {
  count          = var.seal_workspace_credentials ? 1 : 0
  statement_id   = "AllowSealLegacyCredentialsSchedule"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.spore_bot.function_name
  principal      = "events.amazonaws.com"
  source_arn     = aws_cloudwatch_event_rule.seal_legacy_credentials[0].arn
  source_account = local.account_id
}

# ── Lambda function ──────────────────────────────────────────────────────────
# Code + env are deployed/managed out-of-band; Tofu owns the function's SHAPE
# (role, runtime, arch, memory, timeout) but ignores code and environment.

resource "aws_lambda_function" "spore_bot" {
  function_name = local.fn_name
  role          = aws_iam_role.spore_bot.arn
  runtime       = "provided.al2023"
  handler       = "bootstrap"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 120

  # End-to-end request tracing (Semgrep best-practice; paired with xray:Put* in
  # the role). Applies on the next apply — a benign addition to the live function.
  tracing_config {
    mode = "Active"
  }

  # Placeholder code reference; real code comes from `make deploy`. Required by
  # the provider but ignored below so a deploy is never reverted.
  filename = "${path.module}/placeholder.zip"

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
      s3_bucket,
      s3_key,
      s3_object_version,
      environment, # secrets — managed outside source
      layers,
    ]
  }

  tags = local.common_tags
}

# ── Function URL (public; the value Discord + instance notify-URLs depend on) ─
# The URL is deterministic from function name + account + region, so as long as
# the function keeps its name, the URL is preserved across this import.

resource "aws_lambda_function_url" "spore_bot" {
  function_name      = aws_lambda_function.spore_bot.function_name
  authorization_type = "NONE"
  cors {
    allow_methods = ["POST", "GET"]
    allow_origins = ["*"]
  }
}

# Public invoke permission for the Function URL (NONE auth).
resource "aws_lambda_permission" "url_public" {
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.spore_bot.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

output "function_url" {
  value       = aws_lambda_function_url.spore_bot.function_url
  description = "spore-bot Function URL (interactions endpoint base; append /discord, /slack, /teams, /notify)."
}

output "role_arn" {
  value = aws_iam_role.spore_bot.arn
}

output "secrets_key_arn" {
  value       = aws_kms_key.spore_bot_secrets.arn
  description = "KMS key for workspace credentials; alias/spore-bot-secrets points at it once var.seal_workspace_credentials is true."
}
