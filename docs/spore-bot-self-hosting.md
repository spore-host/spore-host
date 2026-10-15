# spore-bot Self-Hosting Guide

This guide is for organizations deploying their own spore.host infrastructure (e.g., a university running a private instance). If you are using the hosted spore.host platform, this guide does not apply — the infrastructure is already deployed.

---

## What this deploys

- **DynamoDB tables:** `spore-bot-registry`, `spore-bot-workspaces`, `spore-bot-audit`
- **Lambda function:** `spore-bot` — handles Slack/Teams/Discord webhooks, EC2 operations
- **Lambda Function URL** — public HTTPS endpoint for Slack slash commands
- **IAM roles** — Lambda execution role with DynamoDB and EC2 permissions

---

## Prerequisites

- AWS account for platform infrastructure (separate from instance accounts)
- AWS CLI configured with admin credentials for the infrastructure account
- Go 1.26+ and the spawn CLI installed locally
- A checkout of the [spawn repo](https://github.com/spore-host/spawn) (for the CloudFormation template in step 3)
- S3 bucket for Lambda deployment artifacts

---

## Deployment

### 1. Build the Lambda

```bash
cd lambda/spore-bot
make build
# Produces: function.zip (linux/arm64 binary)
```

### 2. Upload to S3

```bash
AWS_PROFILE=<infra-account> aws s3 cp function.zip \
  s3://<your-binaries-bucket>/spore-bot/function.zip
```

### 3. Create the stack (first time only)

The template is in the **spawn** repo, not this one. Run this from the spawn checkout:

```bash
AWS_PROFILE=<infra-account> aws cloudformation deploy \
  --stack-name spore-bot \
  --template-file deployment/cloudformation/spore-bot.yaml \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --parameter-overrides \
      Environment=production \
      LambdaCodeBucket=<your-binaries-bucket> \
      LambdaCodeKey=spore-bot/function.zip \
  --region us-east-1
```

### 4. Note the Function URL

```bash
AWS_PROFILE=<infra-account> aws cloudformation describe-stacks --stack-name spore-bot \
  --query 'Stacks[0].Outputs[?OutputKey==`LambdaFunctionUrl`].OutputValue' \
  --output text
```

This URL is the Slack slash command **Request URL** (append `/slack`). Share it with your workspace administrators.

### 5. Get the Lambda execution role ARN

Workspace administrators need this when deploying the cross-account IAM role in their instance accounts:

```bash
AWS_PROFILE=<infra-account> aws lambda get-function-configuration --function-name spore-bot \
  --query 'Role' --output text
```

---

## Configuration

### Platform-level connect code TTL

By default, `/spore connect` codes are valid for 24 hours. To change the platform default, update the Lambda environment variable:

```bash
AWS_PROFILE=<infra-account> aws lambda update-function-configuration \
  --function-name spore-bot \
  --environment 'Variables={BOT_CONNECT_CODE_TTL_HOURS=48}'
```

> **Warning:** `--environment` replaces the function's **entire** set of
> environment variables, including the OAuth, Teams and Discord secrets. Read
> the current set first (`aws lambda get-function-configuration --function-name
> spore-bot --query Environment.Variables`) and pass all of them back with your
> change.

Workspace administrators can set a shorter TTL per workspace using `spawn bot workspace-add --connect-ttl <hours>` but cannot exceed the platform default.

### Updating the Lambda code

After code changes, from this repo:

```bash
cd lambda/spore-bot
make deploy \
  DEPLOY_PROFILE=<infra-account-profile> \
  EXPECTED_ACCOUNT=<infra-account-id> \
  S3_BUCKET=<your-binaries-bucket> \
  REGION=<region>
```

`make deploy` builds the zip, uploads it to `s3://<bucket>/spore-bot/function.zip`,
runs `aws lambda update-function-code`, waits for the update, and then checks
that the live function's `CodeSha256` matches the zip it just built. It stops
with an error if the credentials are for a different account than
`EXPECTED_ACCOUNT`, or if any step fails. It does not touch the stack, the
function's configuration, or its environment variables.

`make verify` re-runs only the last check, against the `function.zip` still in
the directory.

The update-function-code call happens outside CloudFormation. The stack's code
reference does not change, so a later stack update will not roll the code back.

> **Note:** the hosted spore.host deployment does not use this CloudFormation
> stack. There, OpenTofu (`infra/tofu/spore-bot`) owns the function's settings,
> and `make deploy` with its defaults ships the code.

---

## What workspace administrators need from you

Provide each workspace administrator with:

1. **Lambda Function URL** — `https://xxxxx.lambda-url.<region>.on.aws/` (they append `/slack`)
2. **Lambda execution role ARN** — `arn:aws:iam::<account>:role/...` (for cross-account IAM role setup)

They handle everything else: Slack app creation, workspace registration, instance registration.

---

## DNS integration

If you are running a custom domain (e.g., `compute.youruniversity.edu`), configure the dns-updater Lambda to use your domain by setting `DOMAIN_ZONES` in the dns-updater environment. See `spawn/lambda/dns-updater/` for details.

---

## Teams support

The same Lambda handles Teams outgoing webhooks at `/teams`. Workspace setup for Teams uses `spawn bot workspace-add --platform teams` with the Teams HMAC secret instead of a Slack signing secret. The slash command equivalent in Teams is an outgoing webhook configured to POST to the Function URL.
