###############################################################################
# docs-site — OpenTofu module (#404).
#
# Codifies the delivery layer for docs.spore.host, mirroring the dns-updater /
# spore-bot import-onto-live pattern. All of this was created imperatively
# (console/CLI); this module is `tofu import`ed onto the live resources and must
# `tofu plan` to a near-zero diff (only additive managedby tags) before it owns
# anything — see README.md.
#
# WHY THIS EXISTS: docs.spore.host went fully dark (503 on every request) because
# the CloudFront function `spore-host-docs-url-rewrite` had corrupt code (141
# bytes of binary garbage) so CloudFront couldn't run it. Nothing in the repo was
# the source of truth for that function, so a bad manual edit could — and did —
# take the whole docs site down with no reviewable history. This module makes the
# FUNCTION CODE source-controlled (url-rewrite.js) — that is the primary point.
#
# Deliberately NOT managed here (same discipline as the sibling modules):
#   - S3 OBJECT CONTENT: the built VitePress site is deployed by
#     .github/workflows/docs.yaml (`aws s3 sync docs/.vitepress/dist`). Tofu owns
#     the bucket's SHAPE (policy, public-access-block, OAC wiring) but never its
#     objects.
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
    key          = "docs-site/terraform.tfstate"
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
  account_id     = "966362334030"
  bucket_name    = "spore-host-docs"
  domain         = "docs.spore.host"
  hosted_zone_id = "Z0341053304H0DQXF6U4X" # spore.host
  acm_cert_arn   = "arn:aws:acm:us-east-1:966362334030:certificate/76f3c111-af17-4720-bf5f-a8b985a894b5"

  # AWS-managed cache policy "CachingOptimized" — matches the live behavior.
  caching_optimized_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

  common_tags = {
    project   = "spore-host"
    component = "docs-site"
    managedby = "opentofu"
  }
}

# ── CloudFront function (THE reason this module exists) ───────────────────────
# Rewrites VitePress-on-S3 URLs: clean URL `/guides/python-sdk` -> `.html`, a
# directory/`/` -> `index.html`, and passes through anything that already has an
# extension (assets, existing .html). Source of truth is url-rewrite.js in this
# module — `tofu apply` publishes it, so a future change is a reviewable diff and
# corruption cannot silently ship.
resource "aws_cloudfront_function" "url_rewrite" {
  name    = "spore-host-docs-url-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite directory and clean URLs for VitePress on S3"
  publish = true
  code    = file("${path.module}/url-rewrite.js")
}

# ── Origin Access Control ─────────────────────────────────────────────────────
resource "aws_cloudfront_origin_access_control" "docs" {
  name                              = "spore-host-docs-oac"
  description                       = "OAC for docs.spore.host"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ── S3 origin bucket ──────────────────────────────────────────────────────────
# Content is deployed by docs.yaml; Tofu owns only the bucket shape.
#
# AVD-AWS-0132 (no customer-managed KMS key) ignored below: this bucket holds
# ONLY the public VitePress docs site, served unauthenticated to the world via
# CloudFront anyway. No sensitive data to protect; default SSE-S3 (AES256) is
# appropriate and a CMK would add key-management overhead for zero benefit.
#trivy:ignore:AVD-AWS-0132
resource "aws_s3_bucket" "docs" {
  bucket = local.bucket_name
  tags   = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "docs" {
  bucket                  = aws_s3_bucket.docs.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

# OAC-scoped read: only this CloudFront distribution may GetObject.
resource "aws_s3_bucket_policy" "docs" {
  bucket = aws_s3_bucket.docs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "arn:aws:s3:::${local.bucket_name}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.docs.arn
        }
      }
    }]
  })
}

# ── CloudFront distribution ───────────────────────────────────────────────────
#
# AVD-AWS-0011 (no WAF) ignored below deliberately: this distribution serves a
# public, static, read-only documentation site (GET/HEAD only, no forms, no auth,
# no dynamic origin). A WAF would add cost and operational surface for no
# meaningful risk reduction here.
#trivy:ignore:AVD-AWS-0011
resource "aws_cloudfront_distribution" "docs" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = local.domain
  aliases             = [local.domain]
  default_root_object = "index.html"
  price_class         = "PriceClass_All"
  http_version        = "http2and3"

  origin {
    origin_id                = "s3-spore-host-docs"
    domain_name              = "${local.bucket_name}.s3.${var.region}.amazonaws.com"
    origin_access_control_id = aws_cloudfront_origin_access_control.docs.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-spore-host-docs"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = local.caching_optimized_policy_id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.url_rewrite.arn
    }
  }

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = local.acm_cert_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = local.common_tags
}

# ── Route53 alias ─────────────────────────────────────────────────────────────
resource "aws_route53_record" "docs" {
  zone_id = local.hosted_zone_id
  name    = local.domain
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.docs.domain_name
    zone_id                = aws_cloudfront_distribution.docs.hosted_zone_id
    evaluate_target_health = false
  }
}

output "distribution_id" {
  value = aws_cloudfront_distribution.docs.id
}

output "distribution_domain" {
  value = aws_cloudfront_distribution.docs.domain_name
}

output "function_arn" {
  value       = aws_cloudfront_function.url_rewrite.arn
  description = "URL-rewrite CloudFront function ARN (code lives in url-rewrite.js)."
}
