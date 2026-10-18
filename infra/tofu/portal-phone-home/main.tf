###############################################################################
# portal-phone-home — OpenTofu module (spore.host portal, Slice 3).
#
# The BYOA onboarding registrar for the portal. When a user onboards their AWS
# account (via `spawn onboard` or the web CloudFormation quick-create), the newly
# created cross-account role phones home to this Lambda's Function URL to register
# {roleArn, externalId, region}; the portal then knows how to assume into that
# account. Backend for Slice 3 (CLI wizard) + Slice 4 (web quick-create).
#
# Runs in the INFRA account (966362334030), the control plane — same account as
# dns-updater/spore-bot. This module mirrors dns-updater's shape, but unlike that
# import-onto-live module this is a FRESH apply (new function, URL, execution
# role, and DynamoDB table). Function CODE + env are managed out-of-band (Makefile
# upload); Tofu owns the shape and ignore_changes covers code.
#
# SECURITY: the Function URL is AuthType: AWS_IAM (like dns-updater post-#173).
# Principal "*" on the invoke grant means "any SigV4-signed caller", NOT anonymous
# — the onboarding role in the user's account grants ITSELF invoke on this URL in
# its own identity policy (created by the CFN template / CLI wizard), and the
# handler enforces the real authz: it derives the SigV4-verified caller account
# and rejects any body whose roleArn account differs. No allow-list to maintain.
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
    key          = "portal-phone-home/terraform.tfstate"
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
  region  = var.region
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
  fn_name    = "portal-phone-home"
  role_name  = "PortalPhoneHomeLambdaRole"
  table_name = "spore-portal-accounts"
  common_tags = {
    project   = "spore-host"
    component = "portal-phone-home"
    managedby = "opentofu"
  }
}

# ── KMS key for the accounts table ────────────────────────────────────────────
resource "aws_kms_key" "table" {
  description             = "Encrypts the portal-phone-home accounts DynamoDB table"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  tags                    = local.common_tags
}

resource "aws_kms_alias" "table" {
  name          = "alias/portal-phone-home-table"
  target_key_id = aws_kms_key.table.key_id
}

# ── DynamoDB: onboarded-account registry ─────────────────────────────────────
# accountId (the SigV4-verified caller account) is the partition key; one row per
# onboarded account, upserted on re-onboard. On-demand billing (sporadic writes).
resource "aws_dynamodb_table" "accounts" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "accountId"

  attribute {
    name = "accountId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  # Encrypt at rest with a customer-managed CMK (the scanner requires an explicit
  # kms_key_arn, not just the AWS-owned default). The table holds account role
  # ARNs + ExternalIds, so a dedicated rotating key is warranted.
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.table.arn
  }

  tags = local.common_tags
}

# ── KMS key for Lambda environment encryption ────────────────────────────────
# Encrypts the function's environment variables at rest (the scanner flags the
# AWS-default env encryption as insufficient). Env here only holds the table name,
# but a dedicated CMK is cheap and satisfies defense-in-depth.
resource "aws_kms_key" "lambda_env" {
  description             = "Encrypts portal-phone-home Lambda environment variables"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  tags                    = local.common_tags
}

resource "aws_kms_alias" "lambda_env" {
  name          = "alias/portal-phone-home-env"
  target_key_id = aws_kms_key.lambda_env.key_id
}

# ── Execution role ───────────────────────────────────────────────────────────
resource "aws_iam_role" "phone_home" {
  name        = local.role_name
  description = "Lambda execution role for the portal BYOA phone-home registrar"
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
  role       = aws_iam_role.phone_home.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Write/read the accounts table + write X-Ray traces. The KMS grant for the env
# CMK is added separately (lambda decrypts its env at cold start via the service,
# but the execution role needs kms:Decrypt on the CMK).
resource "aws_iam_role_policy" "runtime" {
  name = "PortalPhoneHomeRuntime"
  role = aws_iam_role.phone_home.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AccountsTable"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:GetItem"]
        Resource = aws_dynamodb_table.accounts.arn
      },
      {
        Sid      = "XRayWrite"
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
        Resource = "*"
      },
      {
        Sid      = "DecryptEnv"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.lambda_env.arn
      },
      {
        # DynamoDB SSE with a CMK requires the caller role to have KMS perms on
        # the table key (Decrypt for reads, GenerateDataKey for writes).
        Sid      = "TableKMS"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.table.arn
      },
    ]
  })
}

# ── Lambda function ──────────────────────────────────────────────────────────
# Tofu owns the shape (role, runtime, arch, memory, timeout, env). Code is
# deployed out-of-band via the Makefile (S3 upload + update-function-code); the
# lifecycle block ignores code attributes so a deploy is never reverted.
resource "aws_lambda_function" "phone_home" {
  function_name = local.fn_name
  role          = aws_iam_role.phone_home.arn
  runtime       = "provided.al2023"
  handler       = "bootstrap"
  architectures = ["arm64"]
  memory_size   = 128
  timeout       = 10

  filename = "${path.module}/placeholder.zip"

  # Encrypt environment variables with the dedicated CMK (not the AWS default).
  kms_key_arn = aws_kms_key.lambda_env.arn

  environment {
    variables = {
      ACCOUNTS_TABLE = aws_dynamodb_table.accounts.name
    }
  }

  # End-to-end request tracing (paired with xray:Put* in the runtime policy).
  tracing_config {
    mode = "Active"
  }

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
      s3_bucket,
      s3_key,
      s3_object_version,
    ]
  }

  tags = local.common_tags
}

# ── Function URL (AuthType: AWS_IAM) ─────────────────────────────────────────
resource "aws_lambda_function_url" "phone_home" {
  function_name      = aws_lambda_function.phone_home.function_name
  authorization_type = "AWS_IAM"
  cors {
    allow_methods = ["POST"]
    allow_origins = ["*"]
    allow_headers = ["content-type"]
  }
}

# Any SigV4-signed caller may invoke under AWS_IAM. Access is really controlled by
# the onboarding role's own identity-policy grant + the handler's verified-account
# check — see the header comment and dns-updater's identical rationale.
resource "aws_lambda_permission" "url_iam_invoke" {
  statement_id           = "FunctionURLAllowIAMAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.phone_home.function_name
  principal              = "*"
  function_url_auth_type = "AWS_IAM"
}

# ── Outputs ────────────────────────────────────────────────────────────────────
output "function_url" {
  value       = aws_lambda_function_url.phone_home.function_url
  description = "Phone-home Function URL — onboarding roles POST their registration here."
}

output "function_arn" {
  value = aws_lambda_function.phone_home.arn
}

output "role_arn" {
  value       = aws_iam_role.phone_home.arn
  description = "The phone-home Lambda execution role ARN."
}

output "accounts_table" {
  value = aws_dynamodb_table.accounts.name
}
