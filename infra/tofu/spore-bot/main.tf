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
