# portal-phone-home — OpenTofu module

The **BYOA onboarding registrar** for the spore.host portal. When a user onboards
their AWS account — via the `spawn onboard` CLI wizard (Slice 3) or the web
CloudFormation quick-create (Slice 4) — the newly created cross-account role
**phones home** to this Lambda's Function URL to register `{roleArn, externalId,
region}`. The portal then knows how to `sts:AssumeRole` into that account.

Runs in the **infra account `966362334030`** (the control plane), alongside
`dns-updater` and `spore-bot`.

## What it manages

- `aws_dynamodb_table.accounts` (**`spore-portal-accounts`**) — one row per
  onboarded account, `accountId` (the SigV4-verified caller account) as the
  partition key, on-demand billing, PITR on.
- `aws_iam_role.phone_home` (**`PortalPhoneHomeLambdaRole`**) — execution role,
  scoped to `dynamodb:PutItem`/`GetItem` on that table only.
- `aws_lambda_function.phone_home` — the function **shape** (arm64,
  `provided.al2023`, 128 MB, 10 s, `ACCOUNTS_TABLE` env). Code is deployed
  out-of-band via the Lambda's Makefile; `ignore_changes` covers code attributes.
- `aws_lambda_function_url.phone_home` — **AuthType: AWS_IAM** + the IAM invoke
  grant.

Unlike `dns-updater`/`spore-bot` (import-onto-live), this is a **fresh apply**.

## Security — SigV4-verified-principal model

Mirrors `dns-updater` (spawn#173). The Function URL is `AuthType: AWS_IAM`, so
every request that reaches the handler has passed SigV4 and carries the verified
caller account in `requestContext.authorizer.iam`. The handler trusts **that**
account — never the body — and **rejects any request whose `roleArn` account
differs**. So a caller can only ever register a role in its own account.
`Principal: "*"` on the invoke grant means "any signed caller", not anonymous;
the onboarding role grants itself invoke in its own identity policy. No shared
secret, no allow-list.

## Deploy

```sh
cd infra/tofu/portal-phone-home
tofu init
tofu apply                       # creates table, role, function shape, URL
# then deploy the code:
cd ../../../lambda/portal-phone-home
make deploy                      # or: make upload && aws lambda update-function-code …
```

The `function_url` output is the endpoint the onboarding role POSTs to (bake it
into the CFN template's phone-home custom resource + the `spawn onboard` wizard).

## State

Remote, in the infra account's state bucket (`portal-phone-home/terraform.tfstate`),
locked with an S3 lock file (#580). **No state has been written for this root
yet**: import its resources before the first `plan` (see the import runbook
here and [`../README.md`](../README.md)). Never commit state.
