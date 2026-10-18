###############################################################################
# portal-account-prober — OpenTofu module (spawn#457 lifecycle wiring).
#
# The scheduled caller of accountlifecycle.ApplyProbes. Every run it scans the
# spore-portal-accounts registry, assumes each account's spore-portal-onboard role,
# counts spawn-managed instances across every region, and writes back only the
# lifecycle transitions the state machine decided. It exists so spore.host can
# eventually conclude "this account is gone" and expire the Route53 A-records that
# would otherwise outlive their instances and resolve to a stranger's IP.
#
# Runs in the INFRA account (966362334030), the control plane — same account as
# dns-updater / spore-bot / portal-phone-home. Fresh apply, not import-onto-live.
# Function CODE is managed out-of-band (Makefile upload); Tofu owns the shape.
#
# ── The security decision this module encodes ────────────────────────────────
#
# The prober needs sts:AssumeRole into every onboarded customer account. That is a
# genuinely powerful grant, and the whole point of putting it in a SEPARATE function
# is to keep it away from the two places it could have gone:
#
#   * portal-phone-home already holds the trust relationship — but it is
#     internet-facing under a Function URL. Adding assume-into-any-customer-account
#     there would place that capability one handler bug from the public edge.
#   * spawn's ttl-reaper already assumes into customer accounts every 10 minutes —
#     but a DIFFERENT role (spawn-ttl-reaper-ec2, from a manual CFN deploy, listed
#     in REAPER_ROLE_ARNS). It cannot assume the roles the registry knows about, so
#     pointing it at the registry would mean probing accounts it has no credentials
#     for and recording their unreachability as fact.
#
# This function has no URL, no public trigger, and one EventBridge schedule as its
# only invoker. Its assume-role grant is narrowed three ways below: to a single role
# NAME across all accounts, and (per statement Sid) to nothing else.
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
    key          = "portal-account-prober/terraform.tfstate"
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

variable "accounts_table" {
  type        = string
  default     = "spore-portal-accounts"
  description = "The registry table, created by the portal-phone-home module."
}

variable "onboard_role_name" {
  type        = string
  default     = "spore-portal-onboard"
  description = <<-EOT
    The role NAME created in each customer account by the onboarding template.
    The prober's assume-role grant is scoped to arn:aws:iam::*:role/<this>, i.e.
    this exact name in any account. Must match portal-onboarding-role.yaml's
    RoleName default — a mismatch means every probe is denied, which the state
    machine will (correctly) refuse to interpret, so it fails visibly rather than
    deprovisioning anyone.
  EOT
}

variable "schedule_expression" {
  type    = string
  default = "rate(1 hour)"

  # CADENCE IS COUPLED TO POLICY, not just to cost. accountlifecycle counts K in
  # RUNS, not in elapsed time, so K=6 means six hours here and one hour at the
  # reaper's rate(10 minutes). Hourly is deliberate: unreachability is not urgent
  # (nothing is deleted on the strength of it — see spawn#457 trap 2), and the
  # per-run cost is ~11 DescribeInstances per onboarded account. Change this and
  # the effective K changes with it.
  description = "EventBridge schedule. K is counted in RUNS, so this sets how long K failures actually take."
}

variable "dry_run" {
  type        = bool
  default     = true
  description = <<-EOT
    Start true. In dry-run the prober probes and decides normally but writes no
    lifecycle transitions, so the first production runs can be read from the logs
    before anything is persisted. The rollout that matters: every role onboarded
    before this module existed trusts only the phone-home role and will deny the
    prober. The state machine treats a denial from a never-successfully-probed
    account as no evidence at all, so those accounts are safe either way — dry-run
    is how you CONFIRM that rather than assume it.
  EOT
}

locals {
  fn_name   = "portal-account-prober"
  role_name = "PortalAccountProberLambdaRole"
  common_tags = {
    project   = "spore-host"
    component = "portal-account-prober"
    managedby = "opentofu"
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# The registry + its CMK are owned by the portal-phone-home module; look them up
# rather than duplicating the resources, so there is exactly one table definition.
data "aws_dynamodb_table" "accounts" {
  name = var.accounts_table
}

data "aws_kms_alias" "table" {
  name = "alias/portal-phone-home-table"
}

# ── KMS key for Lambda environment encryption ────────────────────────────────
resource "aws_kms_key" "lambda_env" {
  description             = "Encrypts portal-account-prober Lambda environment variables"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  tags                    = local.common_tags
}

resource "aws_kms_alias" "lambda_env" {
  name          = "alias/portal-account-prober-env"
  target_key_id = aws_kms_key.lambda_env.key_id
}

# ── Execution role ───────────────────────────────────────────────────────────
resource "aws_iam_role" "prober" {
  name        = local.role_name
  description = "Lambda execution role for the portal BYOA account lifecycle prober"
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
  role       = aws_iam_role.prober.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "runtime" {
  name = "PortalAccountProberRuntime"
  role = aws_iam_role.prober.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Scan to enumerate the registry, UpdateItem to persist transitions.
        # Deliberately NO DeleteItem: offboarding is a status transition and the row
        # is the audit trail. Deliberately no PutItem either — the prober must never
        # write a whole row, because that would clobber a concurrent re-onboard's
        # fresh externalId/roleArn with the stale copy this run happened to read.
        Sid      = "AccountsTable"
        Effect   = "Allow"
        Action   = ["dynamodb:Scan", "dynamodb:UpdateItem"]
        Resource = data.aws_dynamodb_table.accounts.arn
      },
      {
        # Assume the onboarding role in customer accounts.
        #
        # The wildcard is in the ACCOUNT field only, and it has to be: the set of
        # onboarded accounts is data in DynamoDB, discovered at runtime, so it cannot
        # be enumerated in a policy that is written before they onboard. What IS
        # pinned is the role NAME — this grant cannot assume any other role in any
        # account, only the one the onboarding template creates.
        #
        # The real authorization is on the far side and not ours to weaken: each
        # customer's trust policy must name this role AND require the per-account
        # ExternalId. A wildcard here grants nothing an account has not separately
        # agreed to; it only expresses that we do not know their account numbers in
        # advance. Narrowing it further would mean a Tofu apply per customer onboard.
        #
        # semgrep flags this as credentials-exposure (no-iam-creds-exposure), which is
        # a fair description: sts:AssumeRole returns credentials by definition. There
        # is no narrower action that does the job — assuming the role IS the job, and
        # it is the same call spawn's ttl-reaper has always made. The suppression is
        # on the ACTION being inherently credential-returning, not on the resource
        # scope; if the resource here ever loosens past a single pinned role name,
        # this justification no longer holds and must be re-argued. (Same inline
        # convention as portal-oidc/main.tf:236 — the directive must sit on the line
        # immediately above the flagged expression.)
        Sid    = "AssumeOnboardedAccountRole"
        Effect = "Allow"
        # nosemgrep: terraform.lang.security.iam.no-iam-creds-exposure.no-iam-creds-exposure
        Action   = "sts:AssumeRole"
        Resource = "arn:aws:iam::*:role/${var.onboard_role_name}"
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
        # DynamoDB SSE with a CMK requires the caller to hold KMS perms on the table
        # key: Decrypt for the Scan, GenerateDataKey for the UpdateItem.
        Sid      = "TableKMS"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = data.aws_kms_alias.table.target_key_arn
      },
    ]
  })
}

# ── Lambda function ──────────────────────────────────────────────────────────
# Timeout is generous because the work is inherently serial-ish per account and
# fans across ~11 regions: an account that times out mid-sweep produces a PARTIAL
# region set, and the prober reports that honestly (EmptinessUnproven), which defers
# dormancy rather than misjudging it. So a short timeout degrades progress, not
# safety — but it degrades it every run, so give it room.
resource "aws_lambda_function" "prober" {
  function_name = local.fn_name
  role          = aws_iam_role.prober.arn
  runtime       = "provided.al2023"
  handler       = "bootstrap"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 300

  filename = "${path.module}/placeholder.zip"

  kms_key_arn = aws_kms_key.lambda_env.arn

  environment {
    variables = {
      ACCOUNTS_TABLE = var.accounts_table
      PROBER_DRY_RUN = tostring(var.dry_run)
      # PROBER_REGIONS unset = the code's default 11-region set (the regions spored
      # is published to). Setting it narrower makes instances in the omitted regions
      # invisible to dormancy, so it is a correctness knob, not a cost knob.
      # PROBER_FAILURES_BEFORE_UNREACHABLE / PROBER_DORMANT_AFTER likewise default
      # to the code's K=6 / N=30d.
    }
  }

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

# ── Schedule ─────────────────────────────────────────────────────────────────
# The function's ONLY invoker. No Function URL, no API Gateway, no public trigger —
# see the header: this is the function that can assume into customer accounts.
resource "aws_cloudwatch_event_rule" "schedule" {
  name                = "${local.fn_name}-schedule"
  description         = "Runs the BYOA account lifecycle prober (spawn#457). K is counted in runs, so this rate sets how long K failures take."
  schedule_expression = var.schedule_expression
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "prober" {
  rule      = aws_cloudwatch_event_rule.schedule.name
  target_id = local.fn_name
  arn       = aws_lambda_function.prober.arn
}

resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.prober.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule.arn
}

# ── Alarms ───────────────────────────────────────────────────────────────────
# KMS key for the log group. Its own key rather than the env key, because the key
# POLICY has to grant logs.amazonaws.com — CloudWatch encrypts on our behalf and is
# refused without it — and that is a grant the env key has no business carrying.
#
# Worth encrypting rather than accepting the AWS-managed default: these logs name
# every onboarded customer account id alongside its lifecycle verdict, which is a
# customer list plus a churn signal.
resource "aws_kms_key" "logs" {
  description             = "Encrypts portal-account-prober CloudWatch logs"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  tags                    = local.common_tags

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowAccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        # Scoped to this log group's ARN via kms:EncryptionContext, so the grant
        # cannot be used to encrypt or read any other log group in the account.
        Sid       = "AllowCloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${data.aws_region.current.name}.amazonaws.com" }
        Action = [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*",
        ]
        Resource = "*"
        Condition = {
          ArnEquals = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.fn_name}"
          }
        }
      },
    ]
  })
}

resource "aws_kms_alias" "logs" {
  name          = "alias/portal-account-prober-logs"
  target_key_id = aws_kms_key.logs.key_id
}

resource "aws_cloudwatch_log_group" "prober" {
  name              = "/aws/lambda/${local.fn_name}"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
  tags              = local.common_tags
}

# THE alarm that matters. ApplyProbes changing nothing when every probe fails is
# correct but SILENTLY correct — a run that concludes nothing because our own
# credentials or trust broke is indistinguishable, from the outside, from a run with
# nothing to do. The handler logs "REFUSING to conclude anything" on that path
# precisely so it can be alarmed on. Without this, the prober can be completely
# broken for weeks while reporting clean runs.
resource "aws_cloudwatch_log_metric_filter" "refused" {
  name           = "${local.fn_name}-refused-correlated-failure"
  log_group_name = aws_cloudwatch_log_group.prober.name
  pattern        = "\"REFUSING to conclude anything\""

  metric_transformation {
    name          = "ProberRefusedCorrelatedFailure"
    namespace     = "spore-host/portal-account-prober"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "refused" {
  alarm_name        = "${local.fn_name}-refused-correlated-failure"
  alarm_description = <<-EOT
    The prober reached ZERO accounts in a run and refused to conclude anything.
    Investigate OUR side first: the prober's execution role, its sts:AssumeRole
    grant, or the onboarding template's trust policy — not the customers. This
    firing means the safety guard worked; it is not an incident about accounts.
  EOT

  namespace           = "spore-host/portal-account-prober"
  metric_name         = "ProberRefusedCorrelatedFailure"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags
}

# A run that errors outright never even reaches the refusal path (e.g. the registry
# Scan failed), so it needs its own alarm.
resource "aws_cloudwatch_metric_alarm" "invocation_errors" {
  alarm_name          = "${local.fn_name}-errors"
  alarm_description   = "portal-account-prober invocations are failing outright; the lifecycle machine is not running at all."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.prober.function_name }
  tags                = local.common_tags
}

# ── Outputs ────────────────────────────────────────────────────────────────────
output "function_arn" {
  value = aws_lambda_function.prober.arn
}

output "role_arn" {
  value       = aws_iam_role.prober.arn
  description = <<-EOT
    The prober's execution role ARN. THIS IS THE VALUE THAT MUST BE ADDED to
    portal-onboarding-role.yaml's ProberLambdaRoleArn parameter, so newly onboarded
    accounts' trust policies admit the prober. Accounts onboarded before that change
    will deny it — safely: the state machine treats a denial from an account that has
    never been probed successfully as no evidence at all.
  EOT
}

output "schedule_expression" {
  value       = aws_cloudwatch_event_rule.schedule.schedule_expression
  description = "K in accountlifecycle is counted in RUNS, so this determines how long K consecutive failures actually take."
}

output "dry_run" {
  value       = var.dry_run
  description = "When true the prober decides but persists nothing."
}
