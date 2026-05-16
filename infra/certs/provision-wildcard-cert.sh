#!/usr/bin/env bash
# Provision a wildcard Let's Encrypt cert for *.<account-base36>.spore.host
# and upload it to a private S3 bucket for spored to consume at instance boot.
#
# Usage:
#   AWS_PROFILE=spore-host-infra ./provision-wildcard-cert.sh <account-base36> [region] [account-id ...]
#
# Extra account IDs are granted cross-account s3:GetObject on the cert bucket
# so instances in those accounts can download the cert via their IAM role.
#
# Example:
#   AWS_PROFILE=spore-host-infra ./provision-wildcard-cert.sh c0zxr0ao us-east-1 942542972736 435415984226
#
# Requirements:
#   pip install certbot certbot-dns-route53
#   AWS credentials must have: Route53 write access to spore.host zone, S3 CreateBucket, PutBucketPolicy
#
# Renewal: re-run every 60 days (cert expires in 90 days)
set -euo pipefail

ACCOUNT_B36="${1:?account base36 required (e.g. c0zxr0ao)}"
REGION="${2:-us-east-1}"
shift 2
EXTRA_ACCOUNTS=("$@")

DOMAIN="*.${ACCOUNT_B36}.spore.host"
BUCKET="spawn-certs-${REGION}"
WORK_DIR="/tmp/certbot-${ACCOUNT_B36}"

echo "==> Provisioning cert for ${DOMAIN} in ${BUCKET}"

# Create private S3 bucket (in spore-host-infra account)
if [ "$REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null || true
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=${REGION}" 2>/dev/null || true
fi

aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# Build bucket policy: grant s3:GetObject to spored-instance-role in each account
INFRA_ACCT=$(aws sts get-caller-identity --query Account --output text)
PRINCIPAL_LIST="\"arn:aws:iam::${INFRA_ACCT}:role/spored-instance-role\""
for ACCT in "${EXTRA_ACCOUNTS[@]}"; do
  PRINCIPAL_LIST+=",\"arn:aws:iam::${ACCT}:role/spored-instance-role\""
done

BUCKET_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "SporeInstanceRoleRead",
    "Effect": "Allow",
    "Principal": {"AWS": [${PRINCIPAL_LIST}]},
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::${BUCKET}/${ACCOUNT_B36}/*"
  }]
}
EOF
)
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$BUCKET_POLICY"
echo "==> Bucket policy set (principals: infra=${INFRA_ACCT}, extra=${EXTRA_ACCOUNTS[*]:-none})"

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

# Upload cert + key with SSE-S3 (not KMS — KMS requires cross-account key policy for instances in other accounts)
aws s3 cp "$CERT_DIR/fullchain.pem" "s3://${BUCKET}/${ACCOUNT_B36}/cert.pem" --sse AES256
aws s3 cp "$CERT_DIR/privkey.pem"   "s3://${BUCKET}/${ACCOUNT_B36}/key.pem"  --sse AES256

echo "==> Uploaded to s3://${BUCKET}/${ACCOUNT_B36}/{cert,key}.pem"
echo "==> Cert valid for 90 days — re-run this script in 60 days"
