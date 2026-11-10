###############################################################################
# portal-oidc — OpenTofu module (spore.host portal, Phase 3).
#
# The net-new AWS trust the default portal (spore-host/web) signs into. The
# browser federates an institutional identity through Globus Auth
# (CILogon/InCommon) and calls sts:AssumeRoleWithWebIdentity directly — no
# backend, no long-lived keys. This module codifies the two pieces that makes
# possible, matching the trust proven live in spawn-ts's demo (demo/README.md):
#
#   1. an IAM OIDC identity provider for https://auth.globus.org
#   2. a role that trust-scopes AssumeRoleWithWebIdentity to
#        - aud == the portal's Globus client-ID   (the app users log into)
#        - sub == an allow-list of Globus identity UUIDs (who may launch)
#      and grants exactly the EC2 launch + iam:PassRole perms a spawn launch needs.
#   3. a read-only audit role for the portal's nightly IAM simulate + drift
#      check (.github/workflows/portal-iam-live.yml), with the GitHub Actions
#      OIDC provider it trusts. This module is their named deleter.
#
# UNLIKE the infra-account modules (dns-updater, spore-bot), this deploys into
# the DEV compute account (435415984226), the account where the demo and the
# #38 cross-account launch were validated and where spored-instance-profile
# exists. Every resource here now exists live and the root has no state yet
# (#671): import them all before the first plan (README, "Import").
#
# Why sub-UUIDs and not email: AWS only exposes a generic OIDC provider's `aud`
# and `sub` as IAM condition keys — `email` is NOT a usable condition key here.
# So "only friedman@ucla.edu" is enforced by pinning `sub` to that person's
# stable Globus identity UUID (resolved via `globus get-identities`), exactly as
# the demo was tightened. Add more users by appending their UUIDs to
# allowed_globus_subs.
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
    key          = "portal-oidc/terraform.tfstate"
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

# The DEV compute account profile — this module deploys the portal's launch
# trust where instances actually run, not into infra.
variable "aws_profile" {
  type    = string
  default = "spore-host-dev"
}

# The portal's Globus public-client UUID (the `aud` the trust checks). This is
# the app registered at developers.globus.org whose redirect URI is the portal
# URL (https://spore.host/app/). Supplied at apply time — there is no default
# because the app registration is an operator step, and a wrong/empty aud would
# make the trust accept nothing (or, if blank, fail to plan).
variable "globus_client_id" {
  type        = string
  description = "Globus public-client UUID registered for the portal (the id_token aud)."

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.globus_client_id))
    error_message = "globus_client_id must be a UUID (the portal's Globus client-ID)."
  }
}

# Allow-list of Globus identity UUIDs permitted to federate + launch. Resolve a
# username with `globus get-identities <user>@<inst>`. Default: friedman@ucla.edu.
variable "allowed_globus_subs" {
  type        = list(string)
  description = "Globus identity UUIDs allowed to assume the portal launch role (sub allow-list)."
  default     = ["66cae890-db2e-11e5-b782-d7b2bd2feb16"] # friedman@ucla.edu

  validation {
    condition     = length(var.allowed_globus_subs) > 0
    error_message = "allowed_globus_subs must not be empty — an empty sub allow-list would let no one in (or, worse, be mistaken for a wildcard). Pin at least one identity."
  }
}

# The instance profile launched instances get (spored self-terminate + DNS
# invoke). Already exists in dev; the role's iam:PassRole is scoped to it.
variable "spored_instance_profile" {
  type    = string
  default = "spored-instance-profile"
}

# The IAM ROLE inside that instance profile. iam:PassRole is evaluated against
# the role's ARN, not the profile's name: granting role/<profile-name> passes a
# role that does not exist, and every portal launch fails with AccessDenied on
# iam:PassRole (seen 2026-11-10). spored-instance-profile contains this role.
variable "spored_instance_role" {
  type    = string
  default = "spored-instance-role"
}

# Other Globus client IDs (auds) this ONE shared IAM OIDC provider must keep
# trusting besides the portal's. AWS allows a single OIDC provider per URL per
# account, and the dev account already has one for auth.globus.org carrying the
# spawn-ts BYOA demo client. Listing it here means importing/managing the provider
# under tofu does NOT revoke the demo's access. Add the demo client by default.
variable "additional_client_ids" {
  type        = list(string)
  description = "Extra Globus client IDs the shared OIDC provider trusts (besides the portal's)."
  default     = ["983c5d9a-dcf3-4294-bcb3-836c8e69c0ba"] # spawn-ts BYOA demo client
}

locals {
  provider_url  = "https://auth.globus.org"
  provider_host = "auth.globus.org"
  role_name     = "spore-portal-launch"
  common_tags = {
    project   = "spore-host"
    component = "portal-oidc"
    managedby = "opentofu"
  }
}

data "aws_caller_identity" "current" {}

# ── OIDC identity provider ────────────────────────────────────────────────────
# Globus as an IAM OIDC provider. AWS permits ONE provider per URL per account, so
# this is a SHARED resource — the dev account already has it (from the spawn-ts
# demo). client_id_list carries the portal's aud PLUS any additional_client_ids
# (the demo's) so importing/managing it here never revokes another app's access.
# Modern AWS verifies the provider's TLS chain against its trust store, so the
# thumbprint isn't security-critical for well-known CAs; AWS reconciles it, and we
# ignore drift on it so a Globus cert rotation doesn't force a diff.
#
# If the provider already exists (dev does), import it before apply:
#   tofu import aws_iam_openid_connect_provider.globus \
#     arn:aws:iam::<account>:oidc-provider/auth.globus.org
resource "aws_iam_openid_connect_provider" "globus" {
  url             = local.provider_url
  client_id_list  = concat([var.globus_client_id], var.additional_client_ids)
  thumbprint_list = ["06b25927c42a721631c1efd9431e648fa62e1e39"] # Globus leaf (dev provider's current value)
  tags            = local.common_tags

  lifecycle {
    ignore_changes = [thumbprint_list]
  }
}

# ── Launch role ───────────────────────────────────────────────────────────────
# Trust: AssumeRoleWithWebIdentity from the Globus provider, gated on
#   aud == portal client-ID   AND   sub ∈ allowed_globus_subs.
# StringEquals on sub with a LIST is an OR over the list (not a wildcard) — so
# only the enumerated identities pass. This is the tightened form from the demo.
resource "aws_iam_role" "portal_launch" {
  name                 = local.role_name
  description          = "spore.host portal - Globus-federated EC2 launch role (browser AssumeRoleWithWebIdentity)"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.globus.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.provider_host}:aud" = var.globus_client_id
          "${local.provider_host}:sub" = var.allowed_globus_subs
        }
      }
    }]
  })
  tags = local.common_tags
}

# EC2 launch: the surface a spawn launch needs (RunInstances, tag, describe).
#
# No Stop, Start or Terminate. The "Lifecycle" statement that granted them
# (tag-gated on spawn:managed) and the separate PortalEC2Manage policy were
# removed from the live role on 2026-11-10 by the owner (spore-host#678): a
# browser tab must not be able to stop or terminate instances (spawn-ts#126).
# Slice 3 (#686) brings them back under the scoped policy of #678 and the
# portal's IAM coverage gate, not by restoring the old statement.
resource "aws_iam_role_policy" "ec2_launch" {
  name = "PortalEC2Launch"
  role = aws_iam_role.portal_launch.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RunAndInspect"
        Effect = "Allow"
        Action = [
          "ec2:RunInstances",
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceStatus",
          "ec2:DescribeImages",
          "ec2:DescribeSubnets",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeVpcs",
          "ec2:DescribeKeyPairs",
          "ec2:CreateTags",
        ]
        Resource = "*"
      },
      {
        Sid    = "ReadSpotAndQuotas"
        Effect = "Allow"
        Action = [
          "ec2:DescribeSpotPriceHistory",
          # AZ-level "is this type offered here right now?" — the capacity signal
          # the lagotto surface polls. Read-only and account-agnostic (offerings
          # are a property of the region, not of any resource), so there is
          # nothing narrower to scope it to than "*".
          "ec2:DescribeInstanceTypeOfferings",
          "servicequotas:GetServiceQuota",
          "servicequotas:ListServiceQuotas",
        ]
        Resource = "*"
      },
    ]
  })
}

# iam:PassRole for the spored instance profile only — required to attach it at
# RunInstances so the instance can self-terminate + call the DNS Lambda.
resource "aws_iam_role_policy" "pass_spored_profile" {
  name = "PortalPassSporedProfile"
  role = aws_iam_role.portal_launch.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      # PassRole is REQUIRED to attach an instance profile at RunInstances, and it
      # is already maximally scoped: a single named role ARN in THIS account (not a
      # wildcard) plus iam:PassedToService=ec2, so it can only ever hand
      # spored-instance-role (the role in spored-instance-profile) to EC2 — nothing else. The rule flags the action
      # unconditionally; the scoping here is the mitigation. (Same inline-suppress
      # convention as spore-bot/main.tf:111. Suppression reviewed + approved by the
      # repo owner, 2026-07-26.)
      # nosemgrep: terraform.lang.security.iam.no-iam-resource-exposure.no-iam-resource-exposure
      Action   = "iam:PassRole"
      Resource = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.spored_instance_role}"
      Condition = {
        StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" }
      }
    }]
  })
}

# SSM Session Manager — the browser terminal surface opens shells via
# ssm:StartSession against portal-launched instances (no SSH).
resource "aws_iam_role_policy" "ssm_session" {
  name = "PortalSSMSession"
  role = aws_iam_role.portal_launch.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Scoped to spawn-managed instances (tagged spawn:managed=true). It
        # previously was not, and that was the widest grant in this role: a shell
        # is at least as powerful as a terminate, so StartSession against
        # `instance/*` let a portal session open a root-capable shell on ANY
        # SSM-registered instance in the account, an unrelated production box the
        # portal never launched, while the then tag-gated ec2:TerminateInstances
        # on the same instance was denied.
        #
        # Still open (#678): ec2:CreateTags on "*" with no condition means a
        # session can tag any instance spawn:managed=true and then open a shell on
        # it. Only the owner's Globus identity can assume this role today. The
        # scoped policy of #678 fixes this before any new tag-gated grant. The only thing narrowing it was a client-side
        # `/^i-[0-9a-f]{8,}$/` on a text field, which is a syntax check, not authz.
        #
        # `ssm:resourceTag/`, not `aws:ResourceTag/`: SSM evaluates the target
        # node's tags under its own service-specific key for StartSession.
        Sid      = "StartSessionOnManagedInstances"
        Effect   = "Allow"
        Action   = ["ssm:StartSession"]
        Resource = "arn:aws:ec2:*:*:instance/*"
        Condition = {
          StringEquals = { "ssm:resourceTag/spawn:managed" = "true" }
        }
      },
      {
        # The session documents, deliberately NOT tag-conditioned and therefore a
        # separate statement. A document is not a tagged instance, so folding it in
        # with the condition above would deny every session — the condition would be
        # evaluated against a resource that carries no `spawn:managed` tag at all.
        # This grants the right to use a shell document, not the right to reach any
        # particular target; the statement above is what decides that.
        Sid    = "StartSessionDocuments"
        Effect = "Allow"
        Action = ["ssm:StartSession"]
        Resource = [
          "arn:aws:ssm:*:*:document/AWS-StartInteractiveCommand",
          "arn:aws:ssm:*:${data.aws_caller_identity.current.account_id}:document/SSM-SessionManagerRunShell",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:TerminateSession", "ssm:ResumeSession"]
        Resource = "arn:aws:ssm:*:*:session/*"
      },
    ]
  })
}

# ── Portal IAM audit role (read-only) ─────────────────────────────────────────
# Assumed by .github/workflows/portal-iam-live.yml for the portal's nightly IAM
# coverage check (spore-host#683): SimulateCustomPolicy over
# web/portal/iam/fixtures/, and a drift check that the inline policies above,
# as deployed, equal web/portal/iam/policies/portal-launch-role.json.
#
# Created by hand on 2026-11-10, then codified here so it has a named deleter
# ("leave no trace"). Matches the live resources exactly; import them before
# the first plan (README, "Import").
#
# The trust admits only workflow runs on refs/heads/main of
# spore-host/spore-host: a pull request's code never gets these credentials,
# which is also why the workflow has no pull_request trigger.

locals {
  github_oidc_host = "token.actions.githubusercontent.com"
}

# The GitHub Actions OIDC provider. One per URL per account, like Globus's.
# thumbprint_list is not set: AWS verifies token.actions.githubusercontent.com
# against its own trust store and fills the field itself, so it is ignored
# rather than pinned.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://${local.github_oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
  tags = {
    "spore-host:component"  = "portal-iam-audit"
    "spore-host:managed-by" = "infra/tofu/portal-oidc"
  }

  lifecycle {
    ignore_changes = [thumbprint_list]
  }
}

resource "aws_iam_role" "portal_iam_audit" {
  name                 = "spore-portal-iam-audit"
  description          = "Read-only: nightly portal IAM simulate + drift check (spore-host#683). Deleter: infra/tofu/portal-oidc."
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.github_oidc_host}:aud" = "sts.amazonaws.com"
          "${local.github_oidc_host}:sub" = "repo:spore-host/spore-host:ref:refs/heads/main"
        }
      }
    }]
  })

  tags = {
    "spore-host:component" = "portal-iam-audit"
  }
}

# Exactly what web/portal/iam/live.test.ts calls: SimulateCustomPolicy (which
# evaluates documents passed in, so it reads nothing and has no resource to
# scope), and reads of the portal role's own policies. sts:GetCallerIdentity
# needs no grant. Nothing here can change anything.
resource "aws_iam_role_policy" "portal_iam_audit" {
  name = "PortalIAMAuditReadOnly"
  role = aws_iam_role.portal_iam_audit.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SimulateCustom"
        Effect   = "Allow"
        Action   = "iam:SimulateCustomPolicy"
        Resource = "*"
      },
      {
        Sid    = "ReadPortalRole"
        Effect = "Allow"
        Action = [
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies",
        ]
        Resource = aws_iam_role.portal_launch.arn
      },
    ]
  })
}

# ── Outputs ────────────────────────────────────────────────────────────────────
output "oidc_provider_arn" {
  value       = aws_iam_openid_connect_provider.globus.arn
  description = "The Globus IAM OIDC provider ARN."
}

output "role_arn" {
  value       = aws_iam_role.portal_launch.arn
  description = "The portal launch role ARN — set this as the portal's VITE_ROLE_ARN."
}

output "iam_audit_role_arn" {
  value       = aws_iam_role.portal_iam_audit.arn
  description = "The read-only audit role portal-iam-live.yml assumes. Set as the repository variable PORTAL_IAM_AUDIT_ROLE_ARN."
}
