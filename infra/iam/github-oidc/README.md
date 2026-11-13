# GitHub Actions OIDC trusts

`trusts.json` holds the trust policy expected for every AWS role a spore.host
workflow assumes through GitHub's OIDC provider (#709). Most of these roles were
created by hand and exist in no IaC, so this file is the reviewable record of
what their trust must say. `scripts/check_oidc_trusts.py` checks it.

| Role | Account | Assumed by | `sub` it must pin | Codified |
|---|---|---|---|---|
| `GitHubActionsDocsDeployRole` | 966362334030 | spore-host `deploy-site.yaml`, `docs.yaml` | `repo:spore-host/spore-host:ref:refs/heads/main` | no |
| `GitHubActions-spore-host-release` | 966362334030 | spawn `release.yaml` (push of a `v*` tag) | StringLike `repo:spore-host/spawn:ref:refs/tags/v*` | no |
| `GitHubActions-spawn-lambda-deploy` | 966362334030 | spawn `deploy-lambdas.yaml` | `repo:spore-host/spawn:environment:production` | spawn `scripts/setup-lambda-deploy-ci-role.sh` |
| `spore-portal-iam-audit` | 435415984226 | spore-host `portal-iam-live.yml` | `repo:spore-host/spore-host:ref:refs/heads/main` | `infra/tofu/portal-oidc` |
| `spore-portal-e2e-teardown` | 435415984226 | spore-host `portal-e2e-aws.yml` | `repo:spore-host/spore-host:ref:refs/heads/main` | `infra/tofu/portal-oidc` |
| role in `secrets.AWS_DEV_ROLE_ARN` | 435415984226 | spore-plugins `integration.yml` | `repo:spore-host/spore-plugins:ref:refs/heads/main` | no |
| roles in `vars.LIVE_SMOKE_*_ROLE_ARN` | 435415984226 | spawn-ts `live-smoke.yml` (`live-smoke` environment) | `repo:spore-host/spawn-ts:environment:live-smoke` | no |

The rules every trust follows:
- the principal is `token.actions.githubusercontent.com` in the role's own account;
- the action is `sts:AssumeRoleWithWebIdentity`;
- `aud` is StringEquals `sts.amazonaws.com`;
- `sub` is StringEquals one exact ref or environment of one repository.

The only StringLike allowed is a tag pattern, for the tag-triggered release. A
`sub` of `repo:spore-host/<repo>:*`, a `refs/heads/*`, or an `aud`-only
condition would let any branch, any pull request or any repository in the org
assume the role.

None of these repositories customizes the OIDC `sub` claim (checked with
`gh api repos/spore-host/<repo>/actions/oidc/customization/sub`: `use_default`),
so the default `repo:<owner>/<repo>:ref:…` / `:environment:…` forms are the
ones GitHub issues.

## In CI

`python3 -I scripts/check_oidc_trusts.py`, with no arguments, makes no AWS
call. It fails when:
- an expected trust breaks a rule above;
- a workflow in this repo assumes a role that isn't listed;
- such a workflow runs on `pull_request`;
- a job's `environment:` disagrees with the trust's `sub`;
- a role marked as codified in `infra/tofu/` carries a different `sub` there.

## Comparing against live IAM

This needs someone with `iam:GetRole` in each account; the script itself makes
no AWS call:

```bash
# 966362334030
aws iam get-role --role-name GitHubActionsDocsDeployRole       > /tmp/docs.json
aws iam get-role --role-name GitHubActions-spore-host-release  > /tmp/release.json
aws iam get-role --role-name GitHubActions-spawn-lambda-deploy > /tmp/lambda.json
python3 -I scripts/check_oidc_trusts.py \
  --live GitHubActionsDocsDeployRole=/tmp/docs.json \
  --live GitHubActions-spore-host-release=/tmp/release.json \
  --live GitHubActions-spawn-lambda-deploy=/tmp/lambda.json

# 435415984226
aws iam get-role --role-name spore-portal-iam-audit    > /tmp/audit.json
aws iam get-role --role-name spore-portal-e2e-teardown > /tmp/teardown.json
python3 -I scripts/check_oidc_trusts.py \
  --live spore-portal-iam-audit=/tmp/audit.json \
  --live spore-portal-e2e-teardown=/tmp/teardown.json
```

For the spore-plugins integration role, the role name is the last path segment
of `secrets.AWS_DEV_ROLE_ARN`. Pass it under the inventory name
`"<the role in secrets.AWS_DEV_ROLE_ARN>"`. For spawn-ts live-smoke, first
check whether `vars.LIVE_SMOKE_ROLE_ARN` is set at all. If it isn't, the role
doesn't exist yet.

A difference is reported per statement. Fix whichever side is wrong: the
live role if it trusts more than listed here, or this file (in a reviewed PR)
if the trust was deliberately changed.
