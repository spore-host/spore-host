# infra/tofu: state and credentials

Every root here keeps its state in one S3 bucket in the infra account
(966362334030), under its own key, locked with OpenTofu's S3 lock file (#580):

| | |
|---|---|
| bucket | `spore-host-tofu-state-966362334030` (us-east-1) |
| key | `<root>/terraform.tfstate`, e.g. `spore-bot/terraform.tfstate` |
| locking | `use_lockfile = true`: a `.tflock` object next to the state; no DynamoDB table |
| safety | versioned (old versions kept 90 days), encrypted, public access blocked, TLS only |

The bucket is created once, idempotently, by [`state-bucket.sh`](state-bucket.sh).
It refuses to run against any account but 966362334030.

## Credentials

The AWS provider cannot resolve a profile whose `source_profile` signs in with
`aws login`: it fails with `failed to load assume role ... of profile
scttfrdmn`, while the AWS CLI handles the same profile. So export the
credentials first and let both the backend and the provider use them:

```sh
eval "$(aws configure export-credentials --profile spore-host-infra --format env)"
unset AWS_PROFILE
export AWS_REGION=us-east-1
tofu init      # first time in a checkout
tofu plan
```

`aws_profile` defaults to empty, which means "use the ambient credentials".
`portal-oidc` is the exception: it deploys into the dev account, so its provider
keeps `aws_profile = "spore-host-dev"`. Its state still lives in the infra
bucket, reached with the exported infra credentials.

## A root with no state yet: import before the first plan

Only `spore-bot` had state when the backend was introduced (it was migrated
with `tofu init -migrate-state`). The other roots' resources exist, but no state
for them was ever kept. Their first `tofu init` finds an empty state. **Import
every resource the root manages (each README has the import runbook or the
resource list) before running `plan` or `apply`.** A plan against empty state
proposes creating resources that already exist.

Never commit state. `*.tfstate` stays gitignored even though nothing should be
written locally any more.
