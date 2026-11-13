#!/usr/bin/env bash
# Provision a wildcard Let's Encrypt cert for *.<account-base36>.spore.host
# and upload it to a private S3 bucket for spored to consume at instance boot.
#
# Usage:
#   AWS_PROFILE=spore-host-infra ./provision-wildcard-cert.sh [--dry-run] [--policy-only] \
#       <account-base36> [region] [account-id ...]
#
# Each extra account ID is ADDED to the principals allowed to s3:GetObject the
# <account-base36>/ prefix of the cert bucket, so instances in that account can
# download the cert via their spored-instance-role. Same-account principals
# need no bucket policy; the bucket account's own role is listed only so the
# statement says who reads the prefix.
#
# The bucket policy is MERGED, never replaced (spore-host#695). The script owns
# one statement per prefix: Allow s3:GetObject on
# arn:aws:s3:::<bucket>/<account-base36>/* whose Sid starts with
# "SporeInstanceRoleRead". Every other statement (SporeAppRoleRead,
# SporeAppRoleReadDev, another prefix's grant, anything added by hand) is
# written back unchanged. Principals are only added, never removed, so a re-run
# without a prefix's extra accounts keeps the accounts granted before. To
# revoke one, edit the bucket policy by hand.
#
#   --dry-run      read the current policy, print the merged one, write nothing
#   --policy-only  merge the bucket policy, then stop (no certbot, no upload)
#
# Example:
#   AWS_PROFILE=spore-host-infra ./provision-wildcard-cert.sh <account-base36> us-east-1 435415984226
#
# Account guard: the caller must be the cert-bucket account (966362334030
# unless CERT_BUCKET_ACCOUNT says otherwise, e.g. 812107987990). 942542972736
# is refused as the caller and as an extra account, and so is the management
# account of the caller's AWS Organization when the caller can read it
# (spawn#1582).
#
# Requirements:
#   jq; pip install certbot certbot-dns-route53
#   AWS credentials must have: Route53 write access to spore.host zone, S3
#   CreateBucket, GetBucketPolicy, PutBucketPolicy, PutBucketPublicAccessBlock,
#   PutObject
#
# Renewal: re-run every 60 days (cert expires in 90 days)
set -euo pipefail

# Accounts no spore.host resource may name, in either direction. Keep in step
# with spawn's forbiddenTrustAccounts (spawn#1582).
FORBIDDEN_ACCOUNTS=(942542972736)
EXPECTED_ACCOUNT="${CERT_BUCKET_ACCOUNT:-966362334030}"

DRY_RUN=0
POLICY_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --policy-only) POLICY_ONLY=1; shift ;;
    --) shift; break ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }

is_forbidden() {
  local a="$1" f
  for f in "${FORBIDDEN_ACCOUNTS[@]}"; do
    [ "$a" = "$f" ] && return 0
  done
  return 1
}

ACCOUNT_B36="${1:?account base36 required (e.g. 1a2b3c4d)}"
REGION="${2:-us-east-1}"
shift $(( $# < 2 ? $# : 2 ))
EXTRA_ACCOUNTS=("$@")

# Both end up inside an ARN and a JSON document; accept nothing else.
[[ "$ACCOUNT_B36" =~ ^[0-9a-z]{1,13}$ ]] || die "account base36 must be 1-13 of [0-9a-z], got '$ACCOUNT_B36'"
[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "not a region: '$REGION'"

command -v jq >/dev/null 2>&1 || die "jq is required"

DOMAIN="*.${ACCOUNT_B36}.spore.host"
BUCKET="spawn-certs-${REGION}"
RESOURCE="arn:aws:s3:::${BUCKET}/${ACCOUNT_B36}/*"
WORK_DIR="${TMPDIR:-/tmp}/certbot-${ACCOUNT_B36}"

# ── Account guard ────────────────────────────────────────────────────────────
CALLER=$(aws sts get-caller-identity --query Account --output text)
[[ "$CALLER" =~ ^[0-9]{12}$ ]] || die "could not determine the caller's account (got '$CALLER')"
is_forbidden "$CALLER" && die "refusing to run as $CALLER (spawn#1582)"
[ "$CALLER" = "$EXPECTED_ACCOUNT" ] || die "credentials are for $CALLER, expected the cert-bucket account $EXPECTED_ACCOUNT (set CERT_BUCKET_ACCOUNT to override)"

# Empty when the caller is in no organization or may not read it; the
# forbidden list above applies either way.
MGMT=$(aws organizations describe-organization --query Organization.MasterAccountId --output text 2>/dev/null || true)
[[ "$MGMT" =~ ^[0-9]{12}$ ]] || MGMT=""
if [ -n "$MGMT" ] && [ "$CALLER" = "$MGMT" ]; then
  die "refusing to run in $CALLER, the management account of its organization"
fi

for ACCT in ${EXTRA_ACCOUNTS[@]+"${EXTRA_ACCOUNTS[@]}"}; do
  [[ "$ACCT" =~ ^[0-9]{12}$ ]] || die "not an account id: '$ACCT'"
  is_forbidden "$ACCT" && die "refusing to grant $ACCT read on $BUCKET (spawn#1582)"
  if [ -n "$MGMT" ] && [ "$ACCT" = "$MGMT" ]; then
    die "refusing to grant $ACCT, the management account of the caller's organization"
  fi
done

echo "==> Provisioning cert for ${DOMAIN} in ${BUCKET} (account ${CALLER})"

# ── Bucket ───────────────────────────────────────────────────────────────────
# --expected-bucket-owner on every call: the private key goes only into a
# bucket this account owns, never into a same-named bucket someone else holds.
if [ "$DRY_RUN" -eq 0 ]; then
  if ! aws s3api head-bucket --bucket "$BUCKET" --expected-bucket-owner "$CALLER" >/dev/null 2>&1; then
    if [ "$REGION" = "us-east-1" ]; then
      aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
    else
      aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
        --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
    fi
  fi
  aws s3api put-public-access-block --bucket "$BUCKET" --expected-bucket-owner "$CALLER" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
fi

# ── Bucket policy: merge, never replace ──────────────────────────────────────
# Only "there is no policy yet" may start from empty. Any other failure to read
# it (AccessDenied, throttling, a wrong bucket) stops the run, or the put below
# would replace statements this script never saw.
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT
if CURRENT=$(aws s3api get-bucket-policy --bucket "$BUCKET" --expected-bucket-owner "$CALLER" \
               --query Policy --output text 2>"$ERR"); then
  :
elif grep -q NoSuchBucketPolicy "$ERR"; then
  CURRENT='{"Version":"2012-10-17","Statement":[]}'
elif [ "$DRY_RUN" -eq 1 ] && grep -q NoSuchBucket "$ERR"; then
  CURRENT='{"Version":"2012-10-17","Statement":[]}'
else
  cat "$ERR" >&2
  die "could not read the bucket policy of $BUCKET; nothing was changed"
fi
echo "$CURRENT" | jq -e 'type == "object"' >/dev/null || die "the current bucket policy is not a JSON object"

# shellcheck disable=SC2016 # jq programs, not shell
ADD=$(jq -cn --arg c "$CALLER" \
  '["arn:aws:iam::" + $c + ":role/spored-instance-role"]
   + ($ARGS.positional | map("arn:aws:iam::" + . + ":role/spored-instance-role")) | unique' \
  --args ${EXTRA_ACCOUNTS[@]+"${EXTRA_ACCOUNTS[@]}"})

# shellcheck disable=SC2016
MERGED=$(echo "$CURRENT" | jq --arg res "$RESOURCE" --arg sid "SporeInstanceRoleRead${ACCOUNT_B36}" \
    --argjson add "$ADD" '
  def arr: if type == "array" then . elif . == null then [] else [.] end;
  # The one statement this script owns for the prefix. Anything that differs
  # from its shape (a Condition, a Deny, another action or principal type)
  # belongs to someone else and is left alone.
  def ours: (.Effect == "Allow")
            and ((.Action | arr) == ["s3:GetObject"])
            and ((.Resource | arr) == [$res])
            and ((.Sid // "") | startswith("SporeInstanceRoleRead"))
            and ((.Principal | type) == "object")
            and ((.Principal | keys) == ["AWS"])
            and (has("Condition") | not);
  .Version //= "2012-10-17"
  | .Statement = (.Statement | arr)
  | ([.Statement[] | select(ours)] | length) as $n
  | if $n > 1 then error("more than one statement grants \($res); merge them by hand first")
    elif $n == 1 then
      .Statement |= map(if ours then .Principal.AWS = ((.Principal.AWS | arr) + $add | unique) else . end)
    else
      .Statement += [{Sid: $sid, Effect: "Allow", Principal: {AWS: $add},
                      Action: "s3:GetObject", Resource: $res}]
    end')

BEFORE_N=$(echo "$CURRENT" | jq '.Statement | if type == "array" then length elif . == null then 0 else 1 end')
AFTER_N=$(echo "$MERGED" | jq '.Statement | length')
[ "$AFTER_N" -ge "$BEFORE_N" ] || die "merge dropped statements ($BEFORE_N -> $AFTER_N); nothing was changed"

# This run never adds a forbidden account (refused above). One that is already
# in the policy is kept, not silently removed, but said out loud.
for F in "${FORBIDDEN_ACCOUNTS[@]}"; do
  if echo "$MERGED" | jq -e --arg f ":$F:" '[.Statement[] | .Principal | tostring | contains($f)] | any' >/dev/null; then
    echo "WARNING: the bucket policy already names account $F; this run keeps it as found (spawn#1582)." >&2
  fi
done

echo "==> Bucket policy: ${BEFORE_N} statement(s) before, ${AFTER_N} after; ${ACCOUNT_B36}/ readable by $(echo "$ADD" | jq -r 'join(", ")') plus any already granted"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "$MERGED" | jq .
  echo "==> --dry-run: nothing written"
  exit 0
fi
aws s3api put-bucket-policy --bucket "$BUCKET" --expected-bucket-owner "$CALLER" --policy "$MERGED"
echo "==> Bucket policy merged"

if [ "$POLICY_ONLY" -eq 1 ]; then
  echo "==> --policy-only: skipping certbot and the upload"
  exit 0
fi

# ── Certificate ──────────────────────────────────────────────────────────────
# Provision cert via certbot + Route53 DNS-01 challenge
if ! command -v certbot >/dev/null 2>&1; then
  pip install --quiet certbot certbot-dns-route53 --break-system-packages
fi
certbot certonly --non-interactive --agree-tos \
  --dns-route53 \
  --key-type rsa --rsa-key-size 2048 \
  -d "$DOMAIN" \
  --email "admin@spore.host" \
  --config-dir "$WORK_DIR/config" \
  --work-dir   "$WORK_DIR/work" \
  --logs-dir   "$WORK_DIR/logs"

# certbot uses the base domain (without wildcard prefix) as the directory name
CERT_DIR="$WORK_DIR/config/live/${ACCOUNT_B36}.spore.host"

# Upload cert + key with SSE-S3 (not KMS — KMS requires cross-account key
# policy for instances in other accounts). s3api put-object rather than
# `aws s3 cp`, which has no --expected-bucket-owner.
for PAIR in "fullchain.pem:cert.pem" "privkey.pem:key.pem"; do
  aws s3api put-object --bucket "$BUCKET" --expected-bucket-owner "$CALLER" \
    --key "${ACCOUNT_B36}/${PAIR#*:}" --body "$CERT_DIR/${PAIR%%:*}" \
    --server-side-encryption AES256 >/dev/null
done

echo "==> Uploaded to s3://${BUCKET}/${ACCOUNT_B36}/{cert,key}.pem"
echo "==> Cert valid for 90 days — re-run this script in 60 days"
