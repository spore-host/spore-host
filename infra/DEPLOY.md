# spore.host — AWS-Internal Institutional Deployment

This document is the complete, executable deployment guide for the spore.host
AWS-internal reference deployment. It is written to be followed by an automated
agent with no prior context. Every command is concrete and verifiable.

---

## Target environment

| Parameter | Value |
|-----------|-------|
| **Account ID** | `812107987990` (Isengard) |
| **Auth method** | Access keys — no named AWS profiles. Set `SPAWN_INFRA_PROFILE=""` and `SPAWN_COMPUTE_PROFILE=""` in the CLI configuration |
| **Region** | `us-east-1` |
| **Environment** | `integ` (prod requires Midway security review — not yet started) |
| **DNS domain** | `spore.research.wwps.aws.dev` |
| **DNS parent zone** | `research.wwps.aws.dev` (in a separate AWS account; agent performs delegation automatically) |
| **SPORE_ENV** | `integ` |

---

## Prerequisites for the executing agent

The agent must have **two sets of AWS credentials** — one for each account involved
in DNS delegation.

### 1. Infra account — 812107987990 (all Lambda/DynamoDB/Route53 work)

```sh
export AWS_ACCESS_KEY_ID=<infra account key>
export AWS_SECRET_ACCESS_KEY=<infra account secret>
export AWS_REGION=us-east-1
```

### 2. Parent DNS account (holds `research.wwps.aws.dev`)

The parent zone lives in a separate account. Store its credentials under a
distinct env var prefix so the agent can switch between them:

```sh
export PARENT_AWS_ACCESS_KEY_ID=<parent account key>
export PARENT_AWS_SECRET_ACCESS_KEY=<parent account secret>
```

The agent switches to the parent account by temporarily overriding the standard
env vars (see Step 1b), then switches back to the infra account.

### 3. Toolchain

- Go 1.21+: `go version`
- AWS CLI v2: `aws --version`
- `jq`: `jq --version`

### 4. Repository

```sh
git clone https://github.com/spore-host/spore-host.git
cd spore-host
```

**Verify infra account access before starting:**
```sh
aws sts get-caller-identity
# Expected: "Account": "812107987990"
```

---

## Step 1a — Create Route53 hosted zone in the infra account

Using the **infra account** credentials (default env vars):

```sh
ZONE_OUTPUT=$(aws route53 create-hosted-zone \
  --name spore.research.wwps.aws.dev \
  --caller-reference "spore-integ-$(date +%s)" \
  --hosted-zone-config Comment="spore.host integ deployment")

ZONE_ID=$(echo "$ZONE_OUTPUT" | jq -r '.HostedZone.Id' | cut -d/ -f3)
echo "Zone ID: $ZONE_ID"

# Capture the 4 NS records assigned to this zone
NS_RECORDS=$(aws route53 list-resource-record-sets \
  --hosted-zone-id "$ZONE_ID" \
  --query "ResourceRecordSets[?Type=='NS'].ResourceRecords[].Value" \
  --output json)
echo "NS records: $NS_RECORDS"
```

## Step 1b — Delegate from parent zone to the new zone (parent account)

Switch to the parent account credentials, find the `research.wwps.aws.dev`
hosted zone, and insert the NS delegation record:

```sh
# Switch to parent account
export AWS_ACCESS_KEY_ID="$PARENT_AWS_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$PARENT_AWS_SECRET_ACCESS_KEY"

# Find the parent zone ID
PARENT_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name research.wwps.aws.dev \
  --query "HostedZones[?Name=='research.wwps.aws.dev.'].Id" \
  --output text | cut -d/ -f3)
echo "Parent zone ID: $PARENT_ZONE_ID"

# Build the NS resource record set from the captured NS records
NS_CHANGE=$(jq -n \
  --argjson ns "$NS_RECORDS" \
  '{
    "Comment": "Delegate spore.research.wwps.aws.dev to infra account",
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "spore.research.wwps.aws.dev",
        "Type": "NS",
        "TTL": 300,
        "ResourceRecords": ($ns | map({"Value": .}))
      }
    }]
  }')

# Apply the delegation
CHANGE_ID=$(aws route53 change-resource-record-sets \
  --hosted-zone-id "$PARENT_ZONE_ID" \
  --change-batch "$NS_CHANGE" \
  --query 'ChangeInfo.Id' --output text)
echo "Change submitted: $CHANGE_ID"

# Wait for propagation (typically <60s)
aws route53 wait resource-record-sets-changed --id "$CHANGE_ID"
echo "Delegation propagated."

# Switch back to infra account
export AWS_ACCESS_KEY_ID=<infra account key>
export AWS_SECRET_ACCESS_KEY=<infra account secret>
```

**Verify delegation is live:**
```sh
dig NS spore.research.wwps.aws.dev
# Expected: 4 NS records matching the infra account's Route53 nameservers
```

---

## Step 2 — IAM role for dns-updater Lambda

```sh
# Create execution role
aws iam create-role \
  --role-name spore-dns-updater-role \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Principal":{"Service":"lambda.amazonaws.com"},
      "Action":"sts:AssumeRole"
    }]
  }'

# Attach basic Lambda logging
aws iam attach-role-policy \
  --role-name spore-dns-updater-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Attach Route53 write permission
aws iam put-role-policy \
  --role-name spore-dns-updater-role \
  --policy-name SporeHostDNSPolicy \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Action":["route53:ChangeResourceRecordSets","route53:GetChange","route53:ListResourceRecordSets"],
      "Resource":"*"
    }]
  }'

DNS_ROLE_ARN=$(aws iam get-role \
  --role-name spore-dns-updater-role \
  --query 'Role.Arn' --output text)
echo "DNS role ARN: $DNS_ROLE_ARN"
```

Wait ~10 seconds for IAM propagation before deploying the Lambda.

---

## Step 3 — Build and deploy the dns-updater Lambda

```sh
cd spawn/lambda/dns-updater

GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o bootstrap .
zip dns-updater.zip bootstrap

# Deploy
aws lambda create-function \
  --function-name spore-dns-updater \
  --runtime provided.al2023 \
  --role "$DNS_ROLE_ARN" \
  --handler bootstrap \
  --architectures arm64 \
  --zip-file fileb://dns-updater.zip \
  --environment "Variables={
    HOSTED_ZONE_ID=$ZONE_ID,
    DEFAULT_DOMAIN=spore.research.wwps.aws.dev
  }" \
  --timeout 30 \
  --memory-size 128 \
  --region us-east-1

# Create the Function URL with AWS_IAM auth. NEVER --auth-type NONE (see
# docs/guides/self-hosting.md): only the accounts whose spores may register
# records get invoke permission. spawn's scripts/deploy-custom-dns.sh does
# exactly this; prefer it over the manual steps below.
aws lambda create-function-url-config \
  --function-name spore-dns-updater \
  --auth-type AWS_IAM \
  --region us-east-1

# One statement per researcher account allowed to register DNS records.
for ACCT in $ALLOWED_ACCOUNTS; do   # space-separated 12-digit account IDs
  aws lambda add-permission \
    --function-name spore-dns-updater \
    --statement-id "AllowAccount-$ACCT" \
    --action lambda:InvokeFunctionUrl \
    --principal "$ACCT" \
    --function-url-auth-type AWS_IAM \
    --region us-east-1
done

# Capture the Function URL
DNS_URL=$(aws lambda get-function-url-config \
  --function-name spore-dns-updater \
  --query 'FunctionUrl' --output text)
echo "DNS endpoint: $DNS_URL"
```

**Verify:** Launch a t3.micro with `--dns-name test` and confirm a record appears
in the `spore.research.wwps.aws.dev` hosted zone.

---

## Step 4 — IAM role for rest-api Lambda

```sh
aws iam create-role \
  --role-name spore-rest-api-role \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Principal":{"Service":"lambda.amazonaws.com"},
      "Action":"sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name spore-rest-api-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws iam put-role-policy \
  --role-name spore-rest-api-role \
  --policy-name SporeHostRestApiPolicy \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[
      {
        "Effect":"Allow",
        "Action":["dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem",
                  "dynamodb:DeleteItem","dynamodb:Query","dynamodb:Scan"],
        "Resource":"arn:aws:dynamodb:us-east-1:812107987990:table/spore-*"
      },
      {
        "Effect":"Allow",
        "Action":["ec2:DescribeInstances","ec2:DescribeTags","ec2:StartInstances",
                  "ec2:StopInstances","ec2:TerminateInstances","ec2:RunInstances",
                  "ec2:CreateTags","ec2:DescribeImages","ec2:DescribeSubnets",
                  "ec2:DescribeSecurityGroups","ec2:DescribeKeyPairs",
                  "ec2:DescribeInstanceTypes","ec2:DescribeSpotPriceHistory",
                  "ec2:DescribeVolumes"],
        "Resource":"*"
      },
      {
        "Effect":"Allow",
        "Action":["iam:PassRole"],
        "Resource":"arn:aws:iam::812107987990:role/spored-instance-role"
      }
    ]
  }'

REST_API_ROLE_ARN=$(aws iam get-role \
  --role-name spore-rest-api-role \
  --query 'Role.Arn' --output text)
echo "Rest API role ARN: $REST_API_ROLE_ARN"
```

---

## Step 5 — DynamoDB tables for rest-api

```sh
# API keys table
aws dynamodb create-table \
  --table-name spore-api-keys \
  --attribute-definitions AttributeName=api_key,AttributeType=S \
  --key-schema AttributeName=api_key,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1

# SMS pending notifications table
aws dynamodb create-table \
  --table-name spore-sms-pending \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --time-to-live-specification AttributeName=ttl,Enabled=true \
  --region us-east-1

echo "Waiting for tables to be active..."
aws dynamodb wait table-exists --table-name spore-api-keys --region us-east-1
aws dynamodb wait table-exists --table-name spore-sms-pending --region us-east-1
echo "Tables ready."
```

---

## Step 6 — Build and deploy the rest-api Lambda

```sh
cd lambda/rest-api

GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o bootstrap .
zip rest-api.zip bootstrap

aws lambda create-function \
  --function-name spore-rest-api \
  --runtime provided.al2023 \
  --role "$REST_API_ROLE_ARN" \
  --handler bootstrap \
  --architectures arm64 \
  --zip-file fileb://rest-api.zip \
  --environment "Variables={
    AWS_REGION=us-east-1,
    API_KEYS_TABLE=spore-api-keys,
    SPORE_NOTIFY_URL=$DNS_URL,
    SPAWN_INFRA_PROFILE=,
    SPAWN_COMPUTE_PROFILE=,
    SPORE_ENV=integ
  }" \
  --timeout 60 \
  --memory-size 256 \
  --region us-east-1

# Create Function URL
aws lambda create-function-url-config \
  --function-name spore-rest-api \
  --auth-type NONE \
  --region us-east-1

aws lambda add-permission \
  --function-name spore-rest-api \
  --statement-id AllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal '*' \
  --function-url-auth-type NONE \
  --region us-east-1

REST_API_URL=$(aws lambda get-function-url-config \
  --function-name spore-rest-api \
  --query 'FunctionUrl' --output text)
echo "REST API URL: $REST_API_URL"
```

---

## Step 7 — Create an API key for the CLI

Keys are stored **hashed** — the `api_key` partition key holds the SHA-256 of
the key, never the plaintext, so a table dump yields no usable credentials
(#374). Hand the plaintext to the user; store only its hash.

```sh
# Generate a key; the table stores its SHA-256, not the key itself.
API_KEY="sk_integ_$(openssl rand -hex 16)"
API_KEY_HASH=$(printf '%s' "$API_KEY" | shasum -a 256 | cut -d' ' -f1)

aws dynamodb put-item \
  --table-name spore-api-keys \
  --item "{
    \"api_key\": {\"S\": \"$API_KEY_HASH\"},
    \"project\": {\"S\": \"spore-aws-internal\"},
    \"created_at\": {\"S\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"},
    \"active\": {\"BOOL\": true}
  }" \
  --region us-east-1

echo "API key: $API_KEY"
echo "Save this — it will not be shown again (only its hash is stored)."
```

> Legacy keys inserted with the plaintext as the partition key still work: the
> rest-api looks up by hash first, then falls back to plaintext and rewrites the
> row to its hashed form on first use.

---

## Step 8 — Configure the CLI for this deployment

Add to `~/.spawn/config.yaml` (or distribute to users):

```yaml
dns:
  enabled: true
  domain: spore.research.wwps.aws.dev
  api_endpoint: <DNS_URL from Step 3>

infrastructure:
  mode: self-hosted
  accounts:
    infra_profile: ""   # use ambient credentials / access keys
    compute_profile: "" # use ambient credentials / access keys
```

Set environment variables for the session:

```sh
export SPORE_ENV=integ
export SPORE_API_URL=<REST_API_URL from Step 6>
export SPORE_API_KEY=<API_KEY from Step 7>
export SPAWN_INFRA_PROFILE=""
export SPAWN_COMPUTE_PROFILE=""
```

---

## Step 9 — Smoke test

```sh
# Verify API key works
curl -s -H "X-API-Key: $SPORE_API_KEY" "$SPORE_API_URL/v1/instances" | jq .

# Launch a minimal test instance (will self-terminate after 10m)
spawn launch \
  --name spore-deploy-test \
  --instance-type t3.micro \
  --region us-east-1 \
  --ttl 10m \
  --dns-name spore-test

# Confirm DNS record was created (after ~60s)
dig spore-test.spore.research.wwps.aws.dev

# Check instance appears in list
spawn list

# Wait for TTL termination (~10m) and confirm DNS record is removed
# dig spore-test.spore.research.wwps.aws.dev  # should return NXDOMAIN
```

---

## Step 10 — Record outputs

After completing the above, record the following values for future reference
(e.g. add to `~/.spawn/config.yaml` and store securely):

| Output | Value |
|--------|-------|
| Route53 Zone ID | `$ZONE_ID` |
| DNS updater URL | `$DNS_URL` |
| REST API URL | `$REST_API_URL` |
| API key | `$API_KEY` (store in a secret manager) |

---

## What this deployment does NOT cover (future work)

| Component | Issue | Notes |
|-----------|-------|-------|
| Dashboard (web UI) | #275 | Requires Midway OIDC integration; integ Midway app registration needed first |
| Slack/SMS notifications | — | Deploy `lambda/spore-bot` following the same pattern as rest-api; requires Slack app registration |
| Sweep orchestration | — | Deploy `spawn/lambda/sweep-orchestrator` for parameter sweep support |
| Full CloudFormation stack | #276 | `make deploy` target that covers all of the above in one command |

---

## Updating an existing deployment

To update a Lambda function after code changes:

```sh
# Example: update dns-updater
cd spawn/lambda/dns-updater
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o bootstrap .
zip dns-updater.zip bootstrap

aws lambda update-function-code \
  --function-name spore-dns-updater \
  --zip-file fileb://dns-updater.zip \
  --region us-east-1
```

---

## Troubleshooting

**DNS records not appearing:**
- Confirm NS delegation is active: `dig NS spore.research.wwps.aws.dev`
- Check Lambda logs: `aws logs tail /aws/lambda/spore-dns-updater --follow`
- Verify `HOSTED_ZONE_ID` env var is set correctly on the Lambda

**API key rejected:**
- Confirm the key was inserted into `spore-api-keys` DynamoDB table
- Check Lambda logs: `aws logs tail /aws/lambda/spore-rest-api --follow`

**Instance launches fail:**
- Verify the rest-api Lambda execution role has `ec2:RunInstances` and `iam:PassRole`
- Check that the AMI ID is valid for `us-east-1` (the default AMI in spore.host configs targets this region)
