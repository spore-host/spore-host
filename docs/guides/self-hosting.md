# Self-Hosting spore.host

This guide covers deploying your own spore.host infrastructure — useful for universities, research institutes, or organizations that want to use their own DNS domain, keep data within their own AWS account, and operate independently of the hosted spore.host service.

::: tip Hosted vs self-hosted
If you just want to use spore.host for your research, you don't need this guide — install the CLI and go. Self-hosting is for institutions that want to operate their own endpoint under a custom domain (e.g. `compute.university.edu`).
:::

## Architecture overview

A self-hosted spore.host deployment consists of:

```
Your infrastructure account (e.g. 966362334030)
  ├── Route53 — your domain (compute.university.edu)
  ├── Lambda — dns-updater (registers instance DNS)
  ├── Lambda — spore-bot (Slack/Teams bot + SMS)
  ├── Lambda — rest-api (Python SDK + SMS backend)
  ├── Lambda — dashboard-api (web dashboard)
  ├── DynamoDB — spore-bot-registry, spore-bot-workspaces
  ├── S3 + CloudFront — your portal (portal.university.edu)
  └── Cognito — dashboard authentication

User compute accounts (your researchers' accounts)
  └── EC2 instances tagged spawn:managed=true
      └── spored daemon pointing at your infrastructure
```

Researchers' EC2 instances call back to your infrastructure for DNS registration, lifecycle notifications, and bot commands.

## Prerequisites

- Two AWS accounts (recommended): one for infrastructure, one for compute. A single account works but separation is cleaner.
- A domain you control in Route53 (e.g. `compute.university.edu`)
- AWS CLI configured with admin credentials for the infrastructure account
- The spore.host CLI installed locally: `brew install spore-host/tap/spawn`

## Step 1: DNS — Route53 hosted zone

Create a hosted zone for your compute subdomain:

```sh
aws route53 create-hosted-zone \
  --name compute.university.edu \
  --caller-reference $(date +%s) \
  --profile infra
```

Note the hosted zone ID — you'll need it throughout. If `compute.university.edu` is a subdomain of a domain you already manage, delegate it by adding NS records in the parent zone.

## Step 2: Deploy the DNS updater Lambda

The dns-updater Lambda registers and deregisters DNS names when instances start and stop. Build and deploy it from source:

```sh
git clone https://github.com/spore-host/spore-host.git
cd spore-host/spawn/lambda/dns-updater

# Build for Linux ARM64
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o bootstrap .
zip dns-updater.zip bootstrap

# Create IAM role
aws iam create-role \
  --role-name spore-dns-updater-role \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }' --profile infra

aws iam put-role-policy \
  --role-name spore-dns-updater-role \
  --policy-name SporesDNSPolicy \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[
      {"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:*:*:*"},
      {"Effect":"Allow","Action":["route53:ChangeResourceRecordSets","route53:GetChange"],"Resource":"*"}
    ]
  }' --profile infra

# Deploy Lambda
aws lambda create-function \
  --function-name spore-dns-updater \
  --runtime provided.al2023 \
  --role arn:aws:iam::YOUR_INFRA_ACCOUNT:role/spore-dns-updater-role \
  --handler bootstrap \
  --architectures arm64 \
  --zip-file fileb://dns-updater.zip \
  --environment "Variables={HOSTED_ZONE_ID=YOUR_ZONE_ID,DNS_DOMAIN=compute.university.edu}" \
  --timeout 30 \
  --region us-east-1 \
  --profile infra

# Create a Function URL
aws lambda create-function-url-config \
  --function-name spore-dns-updater \
  --auth-type NONE \
  --region us-east-1 \
  --profile infra

aws lambda add-permission \
  --function-name spore-dns-updater \
  --statement-id AllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal '*' \
  --function-url-auth-type NONE \
  --region us-east-1 \
  --profile infra
```

Note the Function URL — this is your `DNS_API_ENDPOINT`.

## Step 3: Configure spored on instances

spored reads its configuration from EC2 tags and environment variables. Point it at your infrastructure:

```sh
# In userdata or instance bootstrap script:
export SPORED_DNS_DOMAIN=compute.university.edu
export SPORED_TAG_PREFIX=spawn   # or your institution's prefix

# Or configure via spawn:
spawn launch \
  --dns-domain compute.university.edu \
  --dns-api-endpoint https://YOUR_LAMBDA_URL \
  --name my-instance \
  --instance-type c8a.2xlarge \
  --ttl 8h
```

Save these as defaults so researchers don't need to specify them every time:

```sh
spawn defaults set dns-domain compute.university.edu
```

Or set them in `~/.spawn/config.yaml`:

```yaml
dns:
  enabled: true
  domain: compute.university.edu
  api_endpoint: https://YOUR_LAMBDA_URL
```

## Step 4: Custom tag prefix (optional)

If your institution uses a different brand name (e.g. the University of X deploys this as "UX Compute"), set a custom tag prefix so your instances use `ux:ttl` instead of `spawn:ttl`:

```sh
# On the instance, via userdata:
export SPORED_TAG_PREFIX=ux

# Configure the launch CLI accordingly:
# spawn launch will inject the correct tags automatically
```

## Step 5: Deploy the Slack/Teams bot (optional)

If you want `/spawn` slash commands in your Slack workspace, deploy the spore-bot Lambda:

```sh
cd spore-host/spawn/lambda/spore-bot

GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o bootstrap .
zip spore-bot.zip bootstrap

# Create DynamoDB tables
aws dynamodb create-table \
  --table-name spore-bot-registry \
  --attribute-definitions \
    AttributeName=user_key,AttributeType=S \
    AttributeName=nickname,AttributeType=S \
    AttributeName=instance_id,AttributeType=S \
  --key-schema \
    AttributeName=user_key,KeyType=HASH \
    AttributeName=nickname,KeyType=RANGE \
  --global-secondary-indexes '[{
    "IndexName":"instance_id-index",
    "KeySchema":[{"AttributeName":"instance_id","KeyType":"HASH"}],
    "Projection":{"ProjectionType":"ALL"}
  }]' \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1 --profile infra

aws dynamodb create-table \
  --table-name spore-bot-workspaces \
  --attribute-definitions AttributeName=workspace_key,AttributeType=S \
  --key-schema AttributeName=workspace_key,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1 --profile infra

# Deploy (see spawn/lambda/spore-bot/README for full IAM policy)
aws lambda create-function \
  --function-name spore-bot \
  --runtime provided.al2023 \
  --role arn:aws:iam::YOUR_INFRA_ACCOUNT:role/spore-bot-role \
  --handler bootstrap \
  --architectures arm64 \
  --zip-file fileb://spore-bot.zip \
  --environment "Variables={
    REGISTRY_TABLE=spore-bot-registry,
    WORKSPACES_TABLE=spore-bot-workspaces,
    DNS_DOMAIN=compute.university.edu
  }" \
  --timeout 60 \
  --region us-east-1 --profile infra
```

Then create a Slack app pointing at your Lambda's Function URL (same process as the hosted version — see [Slack Setup](/guides/slack-setup)).

## Step 6: Cross-account access from compute accounts

If researchers launch instances in a different AWS account from your infrastructure, their instances need permission to call your DNS Lambda. The simplest approach: IAM resource policy on the Lambda (allow any principal from your organization).

Alternatively, deploy a cross-account IAM role in each compute account:

```sh
# In each researcher compute account:
aws iam create-role \
  --role-name SpawnBotCrossAccount \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Principal":{"AWS":"arn:aws:iam::YOUR_INFRA_ACCOUNT:role/spore-bot-role"},
      "Action":"sts:AssumeRole",
      "Condition":{"StringEquals":{"sts:ExternalId":"spawn-bot"}}
    }]
  }'

aws iam put-role-policy \
  --role-name SpawnBotCrossAccount \
  --policy-name SpawnBotEC2Control \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Action":["ec2:DescribeInstances","ec2:DescribeTags","ec2:StartInstances",
                "ec2:StopInstances","ec2:CreateTags"],
      "Resource":"*"
    }]
  }'
```

## Step 7: Portal (optional)

Deploy the spore.host web dashboard under your own domain:

```sh
# Create S3 bucket and CloudFront distribution
aws s3 mb s3://your-spore-portal --profile infra
aws s3 website s3://your-spore-portal \
  --index-document index.html \
  --error-document index.html --profile infra

# Deploy the web files
cd spore-host/web
aws s3 sync . s3://your-spore-portal/ \
  --delete --cache-control "max-age=3600" --profile infra
```

Then create a CloudFront distribution pointing at the bucket and configure your DNS record (`portal.university.edu → CloudFront`).

## Configuration reference

All spore.host components read from environment variables and config file (`~/.spawn/config.yaml`):

### CLI environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `SPORE_ENV` | Deployment environment: `integ` or `prod` | `prod` |
| `SPORE_API_URL` | REST API Lambda URL | hosted spore.host |
| `SPORE_API_KEY` | API key for REST API | — |
| `SPORE_NOTIFY_URL` | Notification Lambda callback URL | hosted spore.host |
| `SPORE_DNS_URL` | DNS updater Lambda URL | hosted spore.host |
| `SPORE_BOT_LAMBDA_ROLE_ARN` | Cross-account trust target for bot | hosted spore.host |
| `SPORE_BOT_REGISTRY_TABLE` | DynamoDB table for bot registrations | `spore-bot-registry` |
| `SPORE_BOT_WORKSPACES_TABLE` | DynamoDB table for bot workspaces | `spore-bot-workspaces` |
| `SPAWN_INFRA_PROFILE` | AWS named profile for infra operations (Lambda, DynamoDB, S3) | `spore-host-infra` |
| `SPAWN_COMPUTE_PROFILE` | AWS named profile for EC2 operations | `spore-host-dev` |
| `SPAWN_INFRA_ACCOUNT_ID` | Infra AWS account ID (used in Lambda ARN construction) | `966362334030` |

Set `SPAWN_INFRA_PROFILE=""` and `SPAWN_COMPUTE_PROFILE=""` (empty string) to use the
ambient credential chain instead of named profiles — required for Isengard accounts
and access-key deployments.

### `~/.spawn/config.yaml` keys

```yaml
dns:
  enabled: true
  domain: spore.research.wwps.aws.dev      # your DNS subdomain
  api_endpoint: https://your-dns-lambda/   # dns-updater Function URL

infrastructure:
  mode: self-hosted   # or "shared" for hosted spore.host
  accounts:
    infra_profile: ""   # empty = use ambient credentials
    compute_profile: "" # empty = use ambient credentials
```

### spored (on-instance daemon) environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `SPORED_DNS_DOMAIN` | DNS domain for instance registration | `spore.host` |
| `SPORED_TAG_PREFIX` | Tag namespace prefix | `spawn` |

A researcher at your institution configures their CLI once:

```sh
spawn defaults set dns-domain compute.university.edu
spawn defaults set slack-workspace T03NE3GTY
```

All subsequent launches automatically use your infrastructure.

## Institutional deployment checklist

- [ ] Route53 hosted zone created for `compute.university.edu`
- [ ] dns-updater Lambda deployed and Function URL noted
- [ ] `spawn config.yaml` distributed to researchers with your DNS domain and endpoint
- [ ] Spore-bot Lambda deployed (if using Slack/Teams)
- [ ] Cross-account IAM roles created in researcher accounts
- [ ] Portal deployed at `portal.university.edu` (optional)
- [ ] Test: `spawn launch --name test --instance-type t3.micro --ttl 10m`
- [ ] Test: `nslookup test.compute.university.edu` resolves to instance IP
- [ ] Test: instance terminates after TTL and DNS record is removed
