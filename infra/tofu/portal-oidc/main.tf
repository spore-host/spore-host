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
#      and grants reads only: the 1.0 portal is read-only (#645; #701, #678).
#      The role keeps its name, spore-portal-launch, because the portal build
#      (VITE_ROLE_ARN), the trust and the drift jobs all name it.
#   3. a read-only audit role for the portal's nightly IAM simulate + drift
#      check (.github/workflows/portal-iam-live.yml), with the GitHub Actions
#      OIDC provider it trusts. This module is their named deleter.
#   4. the real-AWS e2e harness's two roles (.github/workflows/portal-e2e-aws.yml):
#      spore-portal-e2e, carrying the portal role's policies verbatim, and
#      spore-portal-e2e-teardown, its observer and teardown.
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

# The instance profile the e2e harness's setup launch attaches (spored
# self-terminate + DNS invoke), so its test instance has spored's TTL backstop.
# The portal role itself passes no role: it is read-only.
variable "spored_instance_profile" {
  type    = string
  default = "spored-instance-profile"
}

# The IAM ROLE inside that instance profile. iam:PassRole is evaluated against
# the role's ARN, not the profile's name: granting role/<profile-name> passes a
# role that does not exist (seen 2026-11-10). spored-instance-profile contains
# this role. The e2e teardown role's setup grant passes it to EC2.
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

# The portal is READ-ONLY for 1.0 (spore-host#645, re-scoped 2026-11-14): sign
# in, list what's running, show prices and quotas, and build CLI commands to
# copy. Its one inline policy grants reads and nothing else.
#
# No RunInstances, CreateTags, iam:PassRole or SSM. This closes, by design:
# - #701: StartSession on every spawn:managed instance in the account, for
#   every identity in allowed_globus_subs, not only on the caller's own;
# - #678: unconditioned ec2:CreateTags on "*", which let a session tag any
#   instance spawn:managed=true and so widen every grant scoped by that tag.
# Actions (launch, extend, stop, terminate, connect) come back after 1.0
# (#686, #687, #689), each behind the portal's IAM coverage gate.
#
# Each action is a read with no resource-level scope in IAM, so "*" is the
# narrowest grant. Deliberately absent: ec2:DescribeInstanceTypeOfferings,
# which answers "is this type offered here", not "is one free" (#679; see
# web/portal/iam/command-actions.ts).
resource "aws_iam_role_policy" "read_only" {
  name = "PortalReadOnly"
  role = aws_iam_role.portal_launch.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Slice 1 (#684): spawn list / spawn status, through spawn-ts's viewer.
        Sid    = "ReadInstances"
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances",
          "ec2:DescribeTags",
        ]
        Resource = "*"
      },
      {
        # Slice 2 (#688), signed in: live Spot prices and quota headroom.
        Sid    = "ReadPricesAndQuotas"
        Effect = "Allow"
        Action = [
          "ec2:DescribeSpotPriceHistory",
          "servicequotas:GetServiceQuota",
          "servicequotas:ListServiceQuotas",
        ]
        Resource = "*"
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
        # The e2e role and the teardown role too: the nightly drift check
        # (iam/live.test.ts) proves the e2e role's policies equal the portal
        # role's, and reads both trusts, or the e2e proofs prove nothing.
        Resource = [
          aws_iam_role.portal_launch.arn,
          aws_iam_role.portal_e2e.arn,
          aws_iam_role.portal_e2e_teardown.arn,
        ]
      },
    ]
  })
}

# ── Portal real-AWS e2e roles ─────────────────────────────────────────────────
# The e2e harness (web/portal/e2e-aws/, spore-host#683) needs credentials whose
# effective permissions are EXACTLY the portal role's. spore-portal-launch
# itself only admits a browser's Globus id_token, so neither CI nor an operator
# can assume it unattended. spore-portal-e2e is its twin for that purpose:
#
# - Its inline policy is the portal role's read-only policy, by name, taken
#   from the resource above (no copy to drift). iam/live.test.ts fails nightly
#   when the deployed e2e role's policies differ from the checked-in portal
#   policy, which the same job proves equals the deployed portal role's.
# - Its trust admits this account's root, narrowed by aws:PrincipalArn to the
#   operator roles in var.e2e_operator_role_names and the teardown role below,
#   and only with a session name starting spore-e2e- (the harness's, which
#   makes SSM sessions and CloudTrail entries attributable to a run). There is
#   NO cross-account trust: every principal ARN is built from this account's
#   id, and the precondition re-checks it.
#
# The teardown role is what CI signs in as (GitHub OIDC, main only). It is the
# harness's setup, observer and teardown: launching the run's t4g.nano test
# instances (the read-only portal role can't), the leak check's reads,
# terminate for t4g.nano instances carrying spore-host:e2e-run only, close for
# spore-e2e-* sessions only, and sts:AssumeRole on the e2e role. Locally the
# operator's own credentials play this part. The e2e role has nothing the
# portal role lacks.
#
# Created by hand from web/portal/iam/policies/portal-e2e-roles.json (which
# gates/iam-e2e-roles.test.ts keeps identical to this), then imported (README).

# Same-account roles operators sign in as, allowed to assume the e2e role. Names,
# not ARNs, so a principal from another account cannot be written here.
variable "e2e_operator_role_names" {
  type        = list(string)
  description = "Roles in THIS account whose sessions may assume spore-portal-e2e (the operator's local run)."
  default     = ["OrganizationAccountAccessRole"]

  validation {
    condition     = alltrue([for n in var.e2e_operator_role_names : can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", n))])
    error_message = "e2e_operator_role_names are role NAMES in this account, not ARNs: a cross-account principal is not allowed here."
  }
}

locals {
  account_id             = data.aws_caller_identity.current.account_id
  e2e_role_name          = "spore-portal-e2e"
  e2e_teardown_role_name = "spore-portal-e2e-teardown"
  e2e_run_tag            = "spore-host:e2e-run"
  e2e_assumers = concat(
    [for n in var.e2e_operator_role_names : "arn:aws:iam::${local.account_id}:role/${n}"],
    ["arn:aws:iam::${local.account_id}:role/${local.e2e_teardown_role_name}"],
  )
}

resource "aws_iam_role" "portal_e2e" {
  name                 = local.e2e_role_name
  description          = "Portal real-AWS e2e: the portal role's policies, assumable by same-account operators and the e2e teardown role (spore-host#683). Deleter: infra/tofu/portal-oidc."
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SameAccountOperatorsAndTeardownRole"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
      Action    = "sts:AssumeRole"
      Condition = {
        ArnEquals  = { "aws:PrincipalArn" = local.e2e_assumers }
        StringLike = { "sts:RoleSessionName" = "spore-e2e-*" }
      }
    }]
  })

  tags = {
    "spore-host:component" = "portal-e2e"
  }

  lifecycle {
    precondition {
      condition     = alltrue([for a in local.e2e_assumers : startswith(a, "arn:aws:iam::${local.account_id}:role/")])
      error_message = "spore-portal-e2e may be assumed only by roles in this account."
    }
  }
}

# The portal role's inline policy, by name, verbatim.
resource "aws_iam_role_policy" "portal_e2e" {
  for_each = {
    PortalReadOnly = aws_iam_role_policy.read_only.policy
  }
  name   = each.key
  role   = aws_iam_role.portal_e2e.id
  policy = each.value
}

resource "aws_iam_role" "portal_e2e_teardown" {
  name                 = local.e2e_teardown_role_name
  description          = "Portal real-AWS e2e observer + teardown: leak-check reads, terminate e2e-tagged instances only (spore-host#683). Deleter: infra/tofu/portal-oidc."
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "GitHubActionsMainOnly"
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
    "spore-host:component" = "portal-e2e"
  }
}

resource "aws_iam_role_policy" "portal_e2e_teardown" {
  name = "PortalE2ETeardown"
  role = aws_iam_role.portal_e2e_teardown.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "BecomeTheE2ERole"
        Effect = "Allow"
        # The rule flags sts:AssumeRole unconditionally because it returns
        # credentials. Here that is the point: CI gets the e2e role's
        # credentials (the portal role's permissions) only through this grant.
        # It is scoped to that one role ARN, whose own trust also requires the
        # spore-e2e-* session name. Same inline-suppress convention as
        # spore-bot/main.tf. Suppression needs the owner's review
        # (spore-host#683).
        # nosemgrep: terraform.lang.security.iam.no-iam-creds-exposure.no-iam-creds-exposure
        Action   = "sts:AssumeRole"
        Resource = aws_iam_role.portal_e2e.arn
      },
      {
        # Describe calls cannot be scoped to resources. Read-only.
        # DescribeImages is the setup launch's AMI lookup (spawn-ts resolveAmi).
        Sid    = "ObserveForTheLeakCheck"
        Effect = "Allow"
        Action = [
          "ec2:DescribeAddresses",
          "ec2:DescribeImages",
          "ec2:DescribeInstances",
          "ec2:DescribeKeyPairs",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeVolumes",
          "ssm:DescribeInstanceInformation",
          "ssm:DescribeSessions",
        ]
        Resource = "*"
      },
      {
        # Only t4g.nano instances that carry the run tag, whatever its value:
        # the harness narrows to its own run id (e2e-aws/leaks.ts
        # teardownTargets). The instance type limits what a tag forged by
        # some other principal can reach to the one type the harness launches
        # (e2e-aws/config.ts INSTANCE_TYPE). The portal and e2e roles can no
        # longer tag anything (#678).
        Sid      = "TerminateE2EInstancesOnly"
        Effect   = "Allow"
        Action   = "ec2:TerminateInstances"
        Resource = "arn:aws:ec2:us-east-1:${local.account_id}:instance/*"
        Condition = {
          Null         = { "aws:ResourceTag/${local.e2e_run_tag}" = "false" }
          StringEquals = { "ec2:InstanceType" = "t4g.nano" }
        }
      },
      {
        # SSM session ids start with the caller's role session name, which the
        # e2e role's trust forces to spore-e2e-*.
        Sid      = "CloseE2ESessionsOnly"
        Effect   = "Allow"
        Action   = "ssm:TerminateSession"
        Resource = "arn:aws:ssm:us-east-1:${local.account_id}:session/spore-e2e-*"
      },
      # ── Setup: the run's test instances ───────────────────────────────────
      # The read-only portal role (and so the e2e role) can't launch, so the
      # harness launches its test instances as this role, through spawn-ts as
      # spawn would (e2e-aws/aws.ts setupLaunch). Only t4g.nano, only with
      # the run tag, only in us-east-1, only from an Amazon image, tagged only
      # within the launch. The e2e role then proves it can list them and
      # can't launch, tag or open a session (e2e-aws/grants.ts).
      {
        Sid      = "LaunchE2EInstancesOnly"
        Effect   = "Allow"
        Action   = "ec2:RunInstances"
        Resource = "arn:aws:ec2:us-east-1:${local.account_id}:instance/*"
        Condition = {
          Null         = { "aws:RequestTag/${local.e2e_run_tag}" = "false" }
          StringEquals = { "ec2:InstanceType" = "t4g.nano" }
        }
      },
      {
        # The resources a launch uses or creates alongside the instance.
        Sid    = "LaunchE2EInstanceResources"
        Effect = "Allow"
        Action = "ec2:RunInstances"
        Resource = [
          "arn:aws:ec2:us-east-1:${local.account_id}:network-interface/*",
          "arn:aws:ec2:us-east-1:${local.account_id}:security-group/*",
          "arn:aws:ec2:us-east-1:${local.account_id}:subnet/*",
          "arn:aws:ec2:us-east-1:${local.account_id}:volume/*",
        ]
      },
      {
        Sid       = "LaunchFromAmazonImages"
        Effect    = "Allow"
        Action    = "ec2:RunInstances"
        Resource  = "arn:aws:ec2:us-east-1::image/*"
        Condition = { StringEquals = { "ec2:Owner" = "amazon" } }
      },
      {
        Sid    = "TagE2EInstancesAtLaunch"
        Effect = "Allow"
        Action = "ec2:CreateTags"
        Resource = [
          "arn:aws:ec2:us-east-1:${local.account_id}:instance/*",
          "arn:aws:ec2:us-east-1:${local.account_id}:network-interface/*",
          "arn:aws:ec2:us-east-1:${local.account_id}:volume/*",
        ]
        Condition = { StringEquals = { "ec2:CreateAction" = "RunInstances" } }
      },
      {
        # spored's instance profile, so the test instance keeps spored's TTL
        # backstop. One named role in this account, to EC2 only. The rule flags
        # PassRole unconditionally; the scoping is the mitigation (same
        # inline-suppress convention as spore-bot/main.tf).
        Sid    = "PassSporedRoleToE2EInstances"
        Effect = "Allow"
        # nosemgrep: terraform.lang.security.iam.no-iam-resource-exposure.no-iam-resource-exposure
        Action    = "iam:PassRole"
        Resource  = "arn:aws:iam::${local.account_id}:role/${var.spored_instance_role}"
        Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } }
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

output "e2e_role_arn" {
  value       = aws_iam_role.portal_e2e.arn
  description = "The portal e2e role (the portal role's policies). Set as the repository variable PORTAL_E2E_ROLE_ARN."
}

output "e2e_teardown_role_arn" {
  value       = aws_iam_role.portal_e2e_teardown.arn
  description = "The e2e observer + teardown role portal-e2e-aws.yml signs in as. Set as the repository variable PORTAL_E2E_TEARDOWN_ROLE_ARN."
}

output "iam_audit_role_arn" {
  value       = aws_iam_role.portal_iam_audit.arn
  description = "The read-only audit role portal-iam-live.yml assumes. Set as the repository variable PORTAL_IAM_AUDIT_ROLE_ARN."
}
