#!/usr/bin/env bash
# live-tfvars.sh — render terraform.tfvars.json for this root from the LIVE
# spore.host distribution's config, so the import plans to zero changes (#717).
#
# It makes no AWS call. Feed it the output of the two read-only calls in
# README.md ("Import"):
#
#   live-tfvars.sh distribution-config.json tags.json > terraform.tfvars.json
#
# It refuses (non-zero exit, naming the setting) a live distribution that has
# anything main.tf does not model: more than one origin, a non-custom origin,
# extra cache behaviors, origin groups, function or Lambda@Edge associations,
# logging, a geo restriction, a response-headers policy already attached, and
# so on. Each of those would plan a change on the first apply; model it in
# main.tf first instead.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 distribution-config.json tags.json" >&2
  exit 2
fi

jq -e --slurpfile tags "$2" '
  def fail(msg): error("live-tfvars: " + msg + "; model it in main.tf before importing");
  def items(x): (x.Items // []);
  def none(x; what): if (x.Quantity // 0) != 0 then fail(what) else . end;

  (.DistributionConfig // fail("input is not get-distribution-config output")) as $c
  | ($c.Origins.Items // []) as $origins
  | ($origins[0] // {}) as $o
  | $c.DefaultCacheBehavior as $b

  | if ($origins | length) != 1 then fail("\($origins | length) origins, expected 1") else . end
  | if $o.CustomOriginConfig == null then fail("the origin is not a custom (S3 website) origin") else . end
  | if ($o.S3OriginConfig // null) != null and ($o.S3OriginConfig.OriginAccessIdentity // "") != "" then fail("an S3 origin with an OAI") else . end
  | if ($o.OriginAccessControlId // "") != "" then fail("an origin access control") else . end
  | if ($o.OriginShield.Enabled // false) then fail("Origin Shield") else . end
  | none($o.CustomHeaders; "custom origin headers")
  | none($c.OriginGroups; "origin groups")
  | none($c.CacheBehaviors; "additional cache behaviors")
  | none($b.FunctionAssociations; "CloudFront function associations")
  | none($b.LambdaFunctionAssociations; "Lambda@Edge associations")
  | none($b.TrustedSigners; "trusted signers")
  | none($b.TrustedKeyGroups; "trusted key groups")
  | if ($b.FieldLevelEncryptionId // "") != "" then fail("field-level encryption") else . end
  | if ($b.RealtimeLogConfigArn // "") != "" then fail("a realtime log config") else . end
  | if ($b.ResponseHeadersPolicyId // "") != "" then fail("a response-headers policy is already attached (\($b.ResponseHeadersPolicyId))") else . end
  | if ($b.TargetOriginId != $o.Id) then fail("the default behavior targets \($b.TargetOriginId), not the origin \($o.Id)") else . end
  | if ($c.Logging.Enabled // false) then fail("access logging") else . end
  | if ($c.Restrictions.GeoRestriction.RestrictionType // "none") != "none" then fail("a geo restriction") else . end
  | if ($c.Enabled != true) then fail("the distribution is disabled") else . end
  | if ($c.Staging // false) then fail("a staging distribution") else . end
  | if ($c.ContinuousDeploymentPolicyId // "") != "" then fail("a continuous-deployment policy") else . end
  | if ($c.ViewerCertificate.ACMCertificateArn // "") == "" then fail("a viewer certificate that is not from ACM") else . end

  | {
      aliases: items($c.Aliases),
      comment: ($c.Comment // ""),
      default_root_object: ($c.DefaultRootObject // ""),
      price_class: $c.PriceClass,
      http_version: $c.HttpVersion,
      is_ipv6_enabled: $c.IsIPV6Enabled,
      web_acl_id: ($c.WebACLId // ""),
      viewer_certificate: {
        acm_certificate_arn: $c.ViewerCertificate.ACMCertificateArn,
        ssl_support_method: $c.ViewerCertificate.SSLSupportMethod,
        minimum_protocol_version: $c.ViewerCertificate.MinimumProtocolVersion
      },
      origin: {
        origin_id: $o.Id,
        domain_name: $o.DomainName,
        origin_path: ($o.OriginPath // ""),
        connection_attempts: $o.ConnectionAttempts,
        connection_timeout: $o.ConnectionTimeout,
        http_port: $o.CustomOriginConfig.HTTPPort,
        https_port: $o.CustomOriginConfig.HTTPSPort,
        origin_protocol_policy: $o.CustomOriginConfig.OriginProtocolPolicy,
        origin_ssl_protocols: items($o.CustomOriginConfig.OriginSslProtocols),
        origin_read_timeout: $o.CustomOriginConfig.OriginReadTimeout,
        origin_keepalive_timeout: $o.CustomOriginConfig.OriginKeepaliveTimeout
      },
      default_cache_behavior: ({
        viewer_protocol_policy: $b.ViewerProtocolPolicy,
        allowed_methods: items($b.AllowedMethods),
        cached_methods: items($b.AllowedMethods.CachedMethods),
        compress: ($b.Compress // false),
        smooth_streaming: ($b.SmoothStreaming // false)
      }
      + (if ($b.CachePolicyId // "") != "" then {cache_policy_id: $b.CachePolicyId} else {} end)
      + (if ($b.OriginRequestPolicyId // "") != "" then {origin_request_policy_id: $b.OriginRequestPolicyId} else {} end)
      + (if ($b.CachePolicyId // "") == "" then {
          forwarded_values: {
            query_string: $b.ForwardedValues.QueryString,
            cookies_forward: $b.ForwardedValues.Cookies.Forward,
            headers: items($b.ForwardedValues.Headers),
            min_ttl: $b.MinTTL,
            default_ttl: $b.DefaultTTL,
            max_ttl: $b.MaxTTL
          }
        } else {} end)),
      custom_error_responses: [items($c.CustomErrorResponses)[] | {
          error_code: .ErrorCode,
          error_caching_min_ttl: .ErrorCachingMinTTL
        }
        + (if (.ResponseCode // "") != "" then {response_code: (.ResponseCode | tonumber)} else {} end)
        + (if (.ResponsePagePath // "") != "" then {response_page_path: .ResponsePagePath} else {} end)
      ],
      tags: ([($tags[0].Tags.Items // [])[] | {(.Key): .Value}] | add // {})
    }
' "$1"
