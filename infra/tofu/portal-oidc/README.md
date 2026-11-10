# portal-oidc — OpenTofu module

The net-new AWS trust the **spore.host default portal** (`spore-host/web`) signs
into. The browser federates an institutional identity through **Globus Auth**
(CILogon/InCommon) and calls `sts:AssumeRoleWithWebIdentity` directly — no
backend, no long-lived keys. This is **Phase 3** of the portal rebuild: the one
piece of net-new infra the portal's sign-in gate needs to work end to end.

It codifies the trust that spawn-ts's demo proved live (see
`spawn-ts/demo/README.md`).

## What it manages

- `aws_iam_openid_connect_provider.globus` — an IAM OIDC provider for
  `https://auth.globus.org`, with `client_id_list = [globus_client_id]`.
- `aws_iam_role.portal_launch` (**`spore-portal-launch`**) — trusts
  `AssumeRoleWithWebIdentity` from that provider, gated on:
  - `auth.globus.org:aud == globus_client_id` (the portal app users log into), and
  - `auth.globus.org:sub ∈ allowed_globus_subs` (who may launch).
- Three inline policies:
  - `PortalEC2Launch`: run, describe and tag (`RunAndInspect`), and Spot price
    and quota reads (`ReadSpotAndQuotas`). **No Stop, Start or Terminate.** The
    tag-gated `Lifecycle` statement and the separate `PortalEC2Manage` policy
    were removed from the live role on 2026-11-10 (#678), so a browser tab can't
    stop or terminate instances (spawn-ts#126). Slice 3 (#686) brings those
    actions back under #678's scoped policy and the portal's IAM coverage gate.
  - `PortalPassSporedProfile`: `iam:PassRole` for `spored-instance-role` (the
    role inside `spored-instance-profile`), to EC2 only.
  - `PortalSSMSession`: `ssm:StartSession` on `spawn:managed` instances, for the
    browser terminal.
- The portal's **read-only IAM audit role**, used by the nightly
  `.github/workflows/portal-iam-live.yml` (SimulateCustomPolicy over
  `web/portal/iam/fixtures/` and the drift check of the three policies above
  against `web/portal/iam/policies/portal-launch-role.json`):
  - `aws_iam_openid_connect_provider.github`: `https://token.actions.githubusercontent.com`,
    audience `sts.amazonaws.com`.
  - `aws_iam_role.portal_iam_audit` (**`spore-portal-iam-audit`**): trusts that
    provider for `repo:spore-host/spore-host:ref:refs/heads/main` only, so pull
    requests never get its credentials.
  - `aws_iam_role_policy.portal_iam_audit` (`PortalIAMAuditReadOnly`):
    `iam:SimulateCustomPolicy`, plus `iam:GetRole`, `GetRolePolicy`,
    `ListRolePolicies` and `ListAttachedRolePolicies` on `spore-portal-launch`
    only.

  These were created by hand on 2026-11-10 and are codified here so this root
  is their deleter. Its ARN is the `iam_audit_role_arn` output and the
  repository variable `PORTAL_IAM_AUDIT_ROLE_ARN`.

Keep `web/portal/iam/policies/portal-launch-role.json` identical to the three
portal policies here: `web/portal/gates/iam-policy-source.test.ts` fails on a
mismatch, and the nightly job fails when the deployed role differs from it.

## Where it deploys

The **dev compute account `435415984226`** (profile `spore-host-dev`) — where the
demo and the #38 cross-account launch were validated and where
`spored-instance-profile` already exists. Everything this root manages now
exists there, so the first run is an import, not a fresh `apply` (see "Import").

## Trust scoping — why UUIDs, not email

AWS only exposes a generic OIDC provider's **`aud`** and **`sub`** as IAM
condition keys — `email` is **not** usable here. So "only friedman@ucla.edu" is
enforced by pinning `sub` to that person's stable **Globus identity UUID**.
Resolve one with:

```sh
globus get-identities friedman@ucla.edu
# → 66cae890-db2e-11e5-b782-d7b2bd2feb16
```

`StringEquals` on `sub` with a **list** is an OR over the list (not a wildcard),
so only the enumerated identities pass. Add users by appending UUIDs to
`allowed_globus_subs`.

## Prerequisites

1. **Register a public Globus app** at [developers.globus.org](https://developers.globus.org)
   (free, no subscription). Type: **public client**. Redirect URI: the portal URL
   (`https://spore.host/app/`). Note the **client-ID (UUID)** → `globus_client_id`.
2. `spored-instance-profile` must exist in the target account (it does in dev).

## Apply

```sh
cd infra/tofu/portal-oidc
tofu init
tofu apply -var="globus_client_id=<portal-globus-client-uuid>"
# allowed_globus_subs defaults to friedman@ucla.edu; override with -var or tfvars.
```

Then wire the portal to the outputs:

```sh
# in spore-host/web/.env (Vite build-time)
VITE_GLOBUS_CLIENT_ID=<portal-globus-client-uuid>
VITE_ROLE_ARN=<role_arn output>
VITE_AWS_REGION=us-east-1
```

## Import

Every resource here already exists in `435415984226`. With the root's state
still empty (#671), import all of them before the first `plan` (credentials as
in [`../README.md`](../README.md)):

```sh
tofu import -var="globus_client_id=<portal-globus-client-uuid>" \
  aws_iam_openid_connect_provider.globus arn:aws:iam::435415984226:oidc-provider/auth.globus.org
tofu import -var="globus_client_id=<uuid>" aws_iam_role.portal_launch spore-portal-launch
tofu import -var="globus_client_id=<uuid>" aws_iam_role_policy.ec2_launch spore-portal-launch:PortalEC2Launch
tofu import -var="globus_client_id=<uuid>" aws_iam_role_policy.pass_spored_profile spore-portal-launch:PortalPassSporedProfile
tofu import -var="globus_client_id=<uuid>" aws_iam_role_policy.ssm_session spore-portal-launch:PortalSSMSession

tofu import -var="globus_client_id=<uuid>" \
  aws_iam_openid_connect_provider.github arn:aws:iam::435415984226:oidc-provider/token.actions.githubusercontent.com
tofu import -var="globus_client_id=<uuid>" aws_iam_role.portal_iam_audit spore-portal-iam-audit
tofu import -var="globus_client_id=<uuid>" aws_iam_role_policy.portal_iam_audit spore-portal-iam-audit:PortalIAMAuditReadOnly
```

Then `tofu plan` should show no changes to the policies. Expected noise: tags
on the Globus provider and the launch role, if the live ones differ from
`common_tags`, and nothing on the GitHub provider's thumbprint (ignored).

## State

Remote, in the infra account's state bucket (`portal-oidc/terraform.tfstate`),
locked with an S3 lock file (#580). Its provider deploys into the dev account (`aws_profile = "spore-host-dev"`); the state is still in the infra bucket. **No state has been written for
this root yet**: import its resources before the first `plan`. Credentials and
the import rule: [`../README.md`](../README.md). Never commit state.
