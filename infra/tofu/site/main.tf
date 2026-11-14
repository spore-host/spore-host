###############################################################################
# site — OpenTofu module (#717).
#
# The CloudFront distribution in front of spore.host (EY67INS5HDFLU), brought
# under tofu by IMPORT, mirroring infra/tofu/docs-site. It was created in the
# console and had no IaC: it appears only in .github/workflows/deploy-site.yaml
# (invalidation) and web/deploy.sh.
#
# Stage 1 (this module as committed) changes NOTHING on the first apply:
#   - the distribution's settings are variables, captured from the live config
#     by live-tfvars.sh (read-only), so the first plan is "1 to import, 0 to
#     add, 0 to change, 0 to destroy";
#   - the security-headers policy exists only when var.security_headers is
#     true, which defaults to false.
# Stage 2 sets security_headers = true: one new response-headers policy,
# attached to the default behavior (CSP in csp.txt, checked against the site
# build in CI). Stage 3 (#717, not here) moves the origin from the S3 website
# endpoint to the REST endpoint with OAC, blocks public access on
# spore-host-website and takes the bucket and policy steps out of web/deploy.sh.
#
# Deliberately NOT managed here: the bucket's objects (deploy-site.yaml), the
# bucket itself and its public policy (stage 3), and the Route53 records.
###############################################################################

terraform {
  # >= 1.10 for the S3 backend's native lock file (use_lockfile); import blocks
  # need >= 1.5.
  required_version = ">= 1.10"

  # State lives in the infra account's state bucket, one key per root, locked
  # with an S3 lock file (#580). See ../README.md for credentials.
  backend "s3" {
    bucket       = "spore-host-tofu-state-966362334030"
    key          = "site/terraform.tfstate"
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
  # export-credentials`, see ../README.md).
  default = ""
}

# ── Stage 2 switch ────────────────────────────────────────────────────────────
variable "security_headers" {
  type        = bool
  description = "Create the spore.host security-headers policy and attach it to the default behavior (#717 stage 2). false for the import (stage 1)."
  default     = false
}

# ── The live distribution's settings (stage 1) ───────────────────────────────
# Every value below is captured from the live distribution by live-tfvars.sh
# into terraform.tfvars.json. None has a default on purpose: a guessed value
# would plan a change to the live site on the first apply.

variable "aliases" {
  type        = list(string)
  description = "Alternate domain names (Aliases.Items)."
}

variable "comment" {
  type = string
}

variable "default_root_object" {
  type = string
}

variable "price_class" {
  type = string
}

variable "http_version" {
  type = string
}

variable "is_ipv6_enabled" {
  type = bool
}

variable "web_acl_id" {
  type        = string
  description = "WebACLId, \"\" for none."
}

variable "viewer_certificate" {
  type = object({
    acm_certificate_arn      = string
    ssl_support_method       = string
    minimum_protocol_version = string
  })

  # TLS 1.2 or later for viewers. If the live distribution allows less, the
  # import stops here: raising it is a behaviour change for its own PR.
  validation {
    condition     = can(regex("^TLSv1\\.(2_(2018|2019|2021)|3_[0-9]{4})$", var.viewer_certificate.minimum_protocol_version))
    error_message = "minimum_protocol_version must be TLSv1.2_2018 or later."
  }
}

# The S3 WEBSITE endpoint, a custom origin (web/deploy.sh). Stage 3 replaces it.
variable "origin" {
  type = object({
    origin_id                = string
    domain_name              = string
    origin_path              = string
    connection_attempts      = number
    connection_timeout       = number
    http_port                = number
    https_port               = number
    origin_protocol_policy   = string
    origin_ssl_protocols     = list(string)
    origin_read_timeout      = number
    origin_keepalive_timeout = number
  })
}

variable "default_cache_behavior" {
  type = object({
    viewer_protocol_policy   = string
    allowed_methods          = list(string)
    cached_methods           = list(string)
    compress                 = bool
    smooth_streaming         = bool
    cache_policy_id          = optional(string)
    origin_request_policy_id = optional(string)
    # Only for a legacy behavior with no cache policy.
    forwarded_values = optional(object({
      query_string    = bool
      cookies_forward = string
      headers         = list(string)
      min_ttl         = number
      default_ttl     = number
      max_ttl         = number
    }))
  })
}

variable "custom_error_responses" {
  type = list(object({
    error_code            = number
    response_code         = optional(number)
    response_page_path    = optional(string)
    error_caching_min_ttl = number
  }))
}

variable "tags" {
  type        = map(string)
  description = "The distribution's tags, as live (list-tags-for-resource)."
}

# ── Response headers (stage 2; the #703/#718 approach) ────────────────────────
# Security headers on every spore.host response, error pages included.
#
# The CSP is in csp.txt, one line, so that scripts/check_docs_csp.py (run by
# web-ci.yml against web/dist) reads the same text CloudFront serves and fails
# a PR that adds a resource the policy would block. What it allows, and why:
#   script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'
#       Every page has inline scripts (the theme check, the install tabs, the
#       Rive and asciinema loaders). No script loads from another origin:
#       Rive and asciinema-player are vendored (#700). 'wasm-unsafe-eval'
#       because both instantiate WebAssembly: Rive fetches its vendored
#       rive.wasm (rive.RuntimeLoader.setWasmUrl), asciinema-player compiles
#       the module it carries inline. No 'unsafe-eval': neither uses eval.
#   style-src 'self' 'unsafe-inline' https://fonts.googleapis.com
#       style="" attributes and <style> blocks, and the Google Fonts CSS.
#   font-src 'self' https://fonts.gstatic.com    the font files.
#   img-src 'self' data:      inline SVG data: icons.
#   connect-src 'self'        demo.cast, the .riv file and rive.wasm. Rive's
#       own fallback to unpkg/jsdelivr is blocked, which is the point.
#   frame-ancestors 'none', object-src 'none', frame-src 'none',
#   worker-src 'none', base-uri 'self', form-action 'self'
#       nothing frames, embeds, spawns a worker or posts.
# The rebuilt portal (#645) will share this origin and needs more in
# connect-src (Globus Auth, AWS endpoints); its slice changes csp.txt.
resource "aws_cloudfront_response_headers_policy" "site" {
  count   = var.security_headers ? 1 : 0
  name    = "spore-host-site-security-headers"
  comment = "Security headers for spore.host (spore-host#717)"

  security_headers_config {
    content_security_policy {
      content_security_policy = trimspace(file("${path.module}/csp.txt"))
      override                = true
    }
    # Two years, subdomains included, as on docs.spore.host. NOT `preload`:
    # on the apex it would put every spore.host subdomain on browsers'
    # HTTPS-only list, which is hard to undo. That is a deliberate decision
    # for its own PR (#717), not a side effect of this one.
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
      override = true
    }
    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin"
      override = true
    }
  }
}

# ── CloudFront distribution (imported) ────────────────────────────────────────
import {
  to = aws_cloudfront_distribution.site
  id = "EY67INS5HDFLU"
}

# AVD-AWS-0011 (no WAF) ignored deliberately, as for docs.spore.host: a public,
# static, read-only site (GET/HEAD only, no forms, no auth, no dynamic origin).
# A WAF would add cost and operational surface for no meaningful risk
# reduction. web_acl_id keeps whatever the live distribution has.
# AVD-AWS-0013 / semgrep aws-insecure-cloudfront-distribution-tls-version
# (minimum TLS version) ignored because neither scanner reads a variable:
# var.viewer_certificate's validation requires TLS 1.2 or later.
#trivy:ignore:AVD-AWS-0011
#trivy:ignore:AVD-AWS-0013
resource "aws_cloudfront_distribution" "site" { # nosemgrep: terraform.aws.security.aws-cloudfront-insecure-tls.aws-insecure-cloudfront-distribution-tls-version
  enabled             = true
  is_ipv6_enabled     = var.is_ipv6_enabled
  comment             = var.comment
  aliases             = var.aliases
  default_root_object = var.default_root_object
  price_class         = var.price_class
  http_version        = var.http_version
  web_acl_id          = var.web_acl_id == "" ? null : var.web_acl_id

  origin {
    origin_id           = var.origin.origin_id
    domain_name         = var.origin.domain_name
    origin_path         = var.origin.origin_path
    connection_attempts = var.origin.connection_attempts
    connection_timeout  = var.origin.connection_timeout

    custom_origin_config {
      http_port                = var.origin.http_port
      https_port               = var.origin.https_port
      origin_protocol_policy   = var.origin.origin_protocol_policy
      origin_ssl_protocols     = var.origin.origin_ssl_protocols
      origin_read_timeout      = var.origin.origin_read_timeout
      origin_keepalive_timeout = var.origin.origin_keepalive_timeout
    }
  }

  default_cache_behavior {
    target_origin_id         = var.origin.origin_id
    viewer_protocol_policy   = var.default_cache_behavior.viewer_protocol_policy
    allowed_methods          = var.default_cache_behavior.allowed_methods
    cached_methods           = var.default_cache_behavior.cached_methods
    compress                 = var.default_cache_behavior.compress
    smooth_streaming         = var.default_cache_behavior.smooth_streaming
    cache_policy_id          = var.default_cache_behavior.cache_policy_id
    origin_request_policy_id = var.default_cache_behavior.origin_request_policy_id
    # null in stage 1: live-tfvars.sh refuses a distribution that already has one.
    response_headers_policy_id = var.security_headers ? aws_cloudfront_response_headers_policy.site[0].id : null

    min_ttl     = var.default_cache_behavior.forwarded_values == null ? null : var.default_cache_behavior.forwarded_values.min_ttl
    default_ttl = var.default_cache_behavior.forwarded_values == null ? null : var.default_cache_behavior.forwarded_values.default_ttl
    max_ttl     = var.default_cache_behavior.forwarded_values == null ? null : var.default_cache_behavior.forwarded_values.max_ttl

    dynamic "forwarded_values" {
      for_each = var.default_cache_behavior.forwarded_values == null ? [] : [var.default_cache_behavior.forwarded_values]
      content {
        query_string = forwarded_values.value.query_string
        headers      = forwarded_values.value.headers
        cookies {
          forward = forwarded_values.value.cookies_forward
        }
      }
    }
  }

  dynamic "custom_error_response" {
    for_each = var.custom_error_responses
    content {
      error_code            = custom_error_response.value.error_code
      response_code         = custom_error_response.value.response_code
      response_page_path    = custom_error_response.value.response_page_path
      error_caching_min_ttl = custom_error_response.value.error_caching_min_ttl
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.viewer_certificate.acm_certificate_arn
    ssl_support_method       = var.viewer_certificate.ssl_support_method
    minimum_protocol_version = var.viewer_certificate.minimum_protocol_version
  }

  tags = var.tags

  lifecycle {
    # The live site must not be replaced or deleted through this root: a new
    # distribution means a new domain name, which breaks the DNS alias.
    prevent_destroy = true
  }
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "distribution_domain" {
  value = aws_cloudfront_distribution.site.domain_name
}

output "response_headers_policy_id" {
  value       = one(aws_cloudfront_response_headers_policy.site[*].id)
  description = "Security-headers policy on the default behavior (CSP in csp.txt). null until security_headers = true."
}
