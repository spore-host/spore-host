---
description: "This guide covers deploying your own spore.host infrastructure — useful for universities, research institutes, or organizations that want to use their own DN…"
---

# Self-Hosting spore.host

This guide covers deploying your own spore.host infrastructure — useful for universities, research institutes, or organizations that want to use their own DNS domain, keep data within their own AWS account, and operate independently of the hosted spore.host service.

::: tip Hosted vs self-hosted
If you just want to use spore.host for your research, you don't need this guide — install the CLI and go. Self-hosting is for institutions that want to operate their own endpoint under a custom domain (e.g. `compute.university.edu`).
:::

## Architecture overview

A self-hosted spore.host deployment consists of:

```
Your infrastructure account (e.g. 111122223333)
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

## Step 2: Deploy the DNS updater

The DNS updater is a Lambda that creates and removes each instance's DNS record.
spored on the instance calls it at boot, and renews a lease beside the record
about hourly. Deploy it with the script in the
[spawn repository](https://github.com/spore-host/spawn), which sets it up the
way spored expects:

```sh
git clone https://github.com/spore-host/spawn.git
cd spawn

SPAWN_LAMBDA_ACCOUNT=YOUR_INFRA_ACCOUNT \
./scripts/deploy-custom-dns.sh \
  --hosted-zone-id YOUR_ZONE_ID \
  --domain compute.university.edu \
  --allow-account 444455556666 --allow-account 777788889999
```

- **`SPAWN_LAMBDA_ACCOUNT` is required for a self-hosted deployment.** Without it,
  the script targets spore.host's own infrastructure account, where it would add
  your zone to spore.host's updater.
- The Function URL is created with **`AuthType: AWS_IAM`**. Only the accounts you
  list with `--allow-account` (by default, just the deploying account) are
  granted `lambda:InvokeFunctionUrl`. They're also added to the updater's account
  allowlist. List every account your researchers launch instances in.
- Never make the Function URL public (`--auth-type NONE`). The updater relies on
  the SigV4 signature to know which account is calling. An unauthenticated URL
  would let anyone create or delete records in your zone.

Note the Function URL it prints: it's your DNS API endpoint. How the updater
authorises callers is described in spawn's
[dns-updater-authorization.md](https://github.com/spore-host/spawn/blob/main/docs/dns-updater-authorization.md),
and the full setup in
[custom-dns.md](https://github.com/spore-host/spawn/blob/main/docs/custom-dns.md).

## Step 3: Point launches at your updater

The launch tells spored where to register by writing two instance tags,
`spawn:dns-domain` and `spawn:dns-endpoint`, so there is nothing to configure on
the instance itself. Set them per launch:

```sh
spawn launch \
  --dns-domain compute.university.edu \
  --dns-api-endpoint https://YOUR_FUNCTION_URL_ID.lambda-url.us-east-1.on.aws/ \
  --name my-instance \
  --instance-type c8a.2xlarge \
  --ttl 8h
```

The endpoint must be a Lambda Function URL (`https://<id>.lambda-url.<region>.on.aws/`).
Requests are SigV4-signed for Lambda, so no other kind of endpoint can
authenticate. spawn validates both values before launching. If spored later
finds a bad value, it registers nothing and sets `spawn:dns-status=failed`; it
never falls back to spore.host.

The easiest way to set this once for everyone launching in an account is SSM:

```sh
aws ssm put-parameter --type String --name /spawn/dns/domain \
  --value compute.university.edu
aws ssm put-parameter --type String --name /spawn/dns/api_endpoint \
  --value https://YOUR_FUNCTION_URL_ID.lambda-url.us-east-1.on.aws/
```

Each value resolves independently, first match wins: the flag, then
`SPAWN_DNS_DOMAIN` / `SPAWN_DNS_API_ENDPOINT`, then `~/.spawn/config.yaml`, then
SSM in the launch's account and region, then spore.host.

Or in each researcher's `~/.spawn/config.yaml`:

```yaml
dns:
  enabled: true
  domain: compute.university.edu
  api_endpoint: https://YOUR_FUNCTION_URL_ID.lambda-url.us-east-1.on.aws/
```

## Step 4: Keep the `spawn:` tag prefix

::: danger Don't set `SPORED_TAG_PREFIX` for spawn launches
spored can read its lifecycle tags under another prefix (`SPORED_TAG_PREFIX=ux`
makes it read `ux:ttl`). That exists for sister projects that write their own
tags. `spawn launch` always writes `spawn:` tags. With a different prefix, spored
finds no `ux:ttl` and **enforces no TTL**, so instances run until someone stops
them.
:::

## Step 5: Deploy the Slack/Teams bot (optional)

If you want `/spawn` slash commands in your Slack workspace, deploy the spore-bot Lambda:

```sh
git clone https://github.com/spore-host/spore-host.git
cd spore-host/lambda/spore-bot

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

# Deploy. The role needs read/write access to both tables and sts:AssumeRole on
# your researchers' SpawnBotCrossAccount roles (Step 6).
aws lambda create-function \
  --function-name spore-bot \
  --runtime provided.al2023 \
  --role arn:aws:iam::YOUR_INFRA_ACCOUNT:role/spore-bot-role \
  --handler bootstrap \
  --architectures arm64 \
  --zip-file fileb://spore-bot.zip \
  --environment "Variables={
    BOT_REGISTRY_TABLE=spore-bot-registry,
    BOT_WORKSPACES_TABLE=spore-bot-workspaces
  }" \
  --timeout 60 \
  --region us-east-1 --profile infra
```

Then create a Slack app pointing at your Lambda's Function URL (same process as the hosted version — see [Slack Setup](/guides/slack-setup)).

## Step 6: Cross-account access for the bot

The bot controls instances in your researchers' accounts by assuming a role in
each one. Researchers don't create that role by hand: `spawn notify register`
creates `SpawnBotCrossAccount` in their account and stores it in the
registration. The role trusts the bot's execution role under a **per-account
ExternalId**. There is no shared ExternalId; the old fixed value was removed.

Point researchers' CLIs at your bot's role, so the role they get trusts it rather
than spore.host's:

```sh
export SPORE_BOT_LAMBDA_ROLE_ARN=arn:aws:iam::YOUR_INFRA_ACCOUNT:role/spore-bot-role
spawn notify register ...
```

If an institution manages roles itself, pass `--role-arn` and the ExternalId in
that role's trust policy with `--external-id`. See `spawn notify register --help`.

Instances calling **your DNS updater** need no role: the accounts you allowed in
Step 2 can invoke it directly.

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
| `SPORE_API_URL` | HTTP API Lambda URL (beta; used by the Python SDK) | hosted spore.host |
| `SPORE_API_KEY` | API key for the HTTP API | — |
| `SPORE_NOTIFY_URL` | Notification Lambda callback URL | hosted spore.host |
| `SPORE_DNS_URL` | DNS updater Lambda URL | hosted spore.host |
| `SPORE_BOT_LAMBDA_ROLE_ARN` | Cross-account trust target for bot | hosted spore.host |
| `SPORE_BOT_REGISTRY_TABLE` | DynamoDB table for bot registrations | `spore-bot-registry` |
| `SPORE_BOT_WORKSPACES_TABLE` | DynamoDB table for bot workspaces | `spore-bot-workspaces` |
| `SPAWN_INFRA_PROFILE` | AWS named profile for infra operations (Lambda, DynamoDB, S3) | `spore-host-infra` |
| `SPAWN_COMPUTE_PROFILE` | AWS named profile for EC2 operations | `spore-host-dev` |
| `SPAWN_INFRA_ACCOUNT_ID` | Infra AWS account ID, used by the scheduler-handler Lambda to build ARNs | spore.host's infrastructure account |

Set `SPAWN_INFRA_PROFILE=""` and `SPAWN_COMPUTE_PROFILE=""` (empty string) to use the
ambient credential chain instead of named profiles, for example when credentials
come from the environment or an SSO session rather than a named profile.

### `~/.spawn/config.yaml` keys

```yaml
dns:
  enabled: true
  domain: compute.university.edu          # your DNS subdomain
  api_endpoint: https://YOUR_FUNCTION_URL_ID.lambda-url.us-east-1.on.aws/   # dns-updater Function URL

infrastructure:
  mode: self-hosted   # or "shared" for hosted spore.host
  accounts:
    infra_profile: ""   # empty = use ambient credentials
    compute_profile: "" # empty = use ambient credentials
```

### spored (on-instance daemon) environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `SPORED_DNS_DOMAIN` | Fallback DNS domain, used only when the instance has no `spawn:dns-domain` tag. Set the domain at launch instead (Step 3). | `spore.host` |
| `SPORED_TAG_PREFIX` | Tag namespace prefix, for sister projects only. Don't set it for spawn launches; see Step 4. | `spawn` |

A researcher at your institution configures their CLI once:

```sh
spawn defaults set slack-workspace T03NE3GTY
```

If you didn't set the DNS domain and endpoint in SSM (Step 3), they set them in
`~/.spawn/config.yaml`:

```yaml
dns:
  domain: compute.university.edu
  api_endpoint: https://YOUR_FUNCTION_URL_ID.lambda-url.us-east-1.on.aws/
```

Launches then register under your zone.

## Institutional deployment checklist

- [ ] Route53 hosted zone created for `compute.university.edu`
- [ ] dns-updater deployed with `scripts/deploy-custom-dns.sh` (`AWS_IAM` auth), every researcher account in `--allow-account`, and the Function URL noted
- [ ] DNS domain and endpoint set in SSM (`/spawn/dns/*`) in each launch account, or in researchers' `~/.spawn/config.yaml`
- [ ] Spore-bot Lambda deployed (if using Slack/Teams)
- [ ] Researchers' CLIs point `SPORE_BOT_LAMBDA_ROLE_ARN` at your bot's role before `spawn notify register` (if using the bot)
- [ ] Portal deployed at `portal.university.edu` (optional)
- [ ] Test: `spawn launch --name test --instance-type t3.micro --ttl 10m`
- [ ] Test: the instance's record resolves. Records are `<name>.<base36-account>.compute.university.edu`, where the middle label is the instance's `spawn:account-base36` tag
- [ ] Test: instance terminates after TTL and DNS record is removed
