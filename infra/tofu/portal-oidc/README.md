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
- Three inline policies: `PortalEC2Launch` (run/describe/tag + tag-scoped
  terminate/stop), `PortalPassSporedProfile` (`iam:PassRole` for
  `spored-instance-profile` only), `PortalSSMSession` (browser terminal).

## Where it deploys

The **dev compute account `435415984226`** (profile `spore-host-dev`) — where the
demo and the #38 cross-account launch were validated and where
`spored-instance-profile` already exists. This is a fresh `apply`, **not** an
import-onto-live like the infra-account modules.

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

## State

Remote, in the infra account's state bucket (`portal-oidc/terraform.tfstate`),
locked with an S3 lock file (#580). Its provider deploys into the dev account (`aws_profile = "spore-host-dev"`); the state is still in the infra bucket. **No state has been written for
this root yet**: import its resources before the first `plan`. Credentials and
the import rule: [`../README.md`](../README.md). Never commit state.
