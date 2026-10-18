#!/usr/bin/env bash
# state-bucket.sh — create (or converge) the S3 bucket holding every
# infra/tofu/* root's state (#580). Idempotent: safe to re-run.
#
# One bucket, one key per root ("<root>/terraform.tfstate"), locked with
# OpenTofu's native S3 lock file (use_lockfile = true, OpenTofu >= 1.10), so no
# DynamoDB table is needed. Versioning keeps every state write recoverable.
#
# Usage:
#   eval "$(aws configure export-credentials --profile spore-host-infra --format env)"
#   unset AWS_PROFILE
#   infra/tofu/state-bucket.sh
set -euo pipefail

EXPECTED_ACCOUNT="${TOFU_STATE_ACCOUNT:-966362334030}"
REGION="us-east-1"
BUCKET="spore-host-tofu-state-${EXPECTED_ACCOUNT}"

# Assert the account: credentials are whatever is ambient, and a state bucket in
# the wrong account would split the roots' state across two places.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [ "$ACCOUNT_ID" != "$EXPECTED_ACCOUNT" ]; then
  echo "ERROR: credentials are for account $ACCOUNT_ID, expected $EXPECTED_ACCOUNT." >&2
  exit 1
fi

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "bucket $BUCKET exists; converging its settings"
else
  # us-east-1 takes no LocationConstraint.
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  echo "created bucket $BUCKET"
fi

aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-ownership-controls --bucket "$BUCKET" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
# Old state versions are kept 90 days, then expire; the current version never does.
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" >/dev/null --lifecycle-configuration \
  '{"Rules":[{"ID":"expire-old-state-versions","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":90},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'
# TLS only.
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<EOF
{"Version":"2012-10-17","Statement":[{"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*","Action":"s3:*",
"Resource":["arn:aws:s3:::${BUCKET}","arn:aws:s3:::${BUCKET}/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}
EOF
)"
aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging \
  'TagSet=[{Key=spore-host:purpose,Value=tofu-state},{Key=spore-host:managed-by,Value=infra/tofu/state-bucket.sh}]'

echo "state bucket ready: s3://$BUCKET (versioned, encrypted, public access blocked, TLS only)"
