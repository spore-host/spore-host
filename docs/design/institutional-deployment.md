---
description: "Design draft: installing spore.host's infrastructure into an institutional (company or university) AWS account or organization. Design only; nothing here is implemented."
---

# Institutional deployment: design

::: warning Draft design, not documentation
This is a design proposal for [spore-host#273](https://github.com/spore-host/spore-host/issues/273).
**Nothing in it is implemented.** A sentence that describes current behaviour
says "today". Everything else is a proposal. The decisions the owner has to make
are numbered **D1–D18** and collected in [§16](#_16-decisions-for-the-owner).
The suite stays on 0.x throughout; nothing here implies a 1.0.0.
:::

**Scope.** How a company or university (the *institution*) installs and runs
spore.host's control plane in AWS accounts it owns, in the pre-1.0 phase. It covers
deployment models, installation and upgrades, identity, tenancy, configuration,
networking, governance, distribution, the refactoring required, a readiness checklist
that matches the Phase 0 discovery on #273, and the documentation plan
([#652](https://github.com/spore-host/spore-host/issues/652)).

**Inputs.** #273 and its children #274–#277, #377, #579, #636, spawn#780 (the three
deployment shapes), spawn#1537, spawn#1302, spawn#1515, the
[self-hosting guide](../guides/self-hosting.md), `infra/DEPLOY.md`, spawn's
`docs/infra-account.md`, and a code search of spawn `cc7b277`, spore-host `72dd1f9`,
lagotto `a9154c7`, truffle `3e2547e`, libs `d7ca20f`, spore-host-mcp `6a72b42`,
spawn-ts `e93a5ec`, truffle-ts `f79b330`, lagotto-ts `b9051db` and python-sdk
`5af7db3` (all on 2026-11-08). No AWS call was made to write this.

**Reference target.** Account 812107987990, domain `spore.research.wwps.aws.dev`
(delegated from `research.wwps.aws.dev`), Midway as the IdP (integ first; prod needs
a security review with lead time).

---

## 1. Summary

The recommendation, in one place:

1. **Start with one account.** The first institutional deployment, the reference one
   included, is *single-account*: control plane and compute in the same account, so
   there is no cross-account trust anywhere. The *organization* layout (a hub account
   plus member compute accounts) follows, built on the same artifacts. (D1)
2. **The institution pulls; spore.host never pushes.** spore.host publishes a
   versioned, signed deployment bundle. The institution's cloud team installs it with
   its own credentials, through its own change control. spore.host holds no
   credentials, no CI role and no trust in any institutional account.
3. **The bundle is CloudFormation**, with a thin `spawn infra` wrapper for plan, apply,
   status, upgrade and teardown, StackSets for member accounts, and a Terraform/OpenTofu
   wrapper module around the same templates. (D2)
4. **IAM is the only authorization plane.** The institution's IdP federates people into
   AWS: `aws login` or IAM Identity Center for the CLI, and an identity broker for the
   portal. spore.host reads the verified AWS principal, its principal tags (the team)
   and its source identity (the person). It does not run a second user database. (D4, D5)
5. **One deployment descriptor** tells every client (spawn, truffle, lagotto, the MCP
   server, the TS ports, the portal, the Python SDK) where the institution's deployment
   is. It is published per account and region in SSM, and on the portal's domain.
   **Institutional mode fails closed:** if the descriptor names no endpoint for a
   feature, the feature is off. It never falls back to spore.host's hosted endpoints.
6. **Names are fixed where AWS scopes them to an account** (tables, functions, roles)
   and parameterized only where they are global (S3 buckets, domains) or point at
   another account (ARNs). That is a much smaller refactor than prefixing everything
   with a stack name, as #276 first proposed. (D3)
7. **Hard constraint, enforced in code:** the installer refuses any trust policy whose
   trusted principal is outside the trusting account's own AWS Organization. It also
   refuses, unconditionally, to create anything in 942542972736 and to name any
   spore.host-operated account (966362334030, 435415984226) as a trusted principal.
8. **The refactoring is 34 items** ([§12](#_12-refactoring-required)): 8 S, 19 M, 7 L.
   The single-account reference deployment needs 19 of them (Phase A). The org layout
   and chargeback need the rest.

---

## 2. Terms and principles

| term | meaning |
|---|---|
| institution | the company or university that owns the AWS accounts |
| installer | the institution's cloud or platform team, who install and operate the deployment |
| deployment | one installed instance of spore.host's control plane, identified by a `deployment_id` |
| hub account | the account holding the control plane (Lambdas, tables, portal, DNS zone). spore.host's equivalent today is 966362334030 |
| member account | an account where instances launch. spore.host's equivalent today is 435415984226 |
| descriptor | the JSON document that tells clients where a deployment's endpoints and resources are ([§7](#_7-configuration-and-discovery)) |
| bundle | the versioned, signed set of templates, Lambda zips, portal build and manifest for one release ([§4](#_4-installation-delivery-upgrades-teardown)) |
| hosted mode | today's behaviour: spore.host's own control plane in 966362334030 |
| institutional mode | a client that has found a descriptor and uses only the institution's endpoints |

spawn#780 named three deployment *shapes*. This design maps onto them:

| shape (spawn#780) | what it is | in this design |
|---|---|---|
| 1. Shared | user accounts trust spore.host's infra account | hosted mode, unchanged. **Never used by an institution** |
| 2. In-account | `spawn reaper deploy` puts a reaper inside the user's account; it holds no `sts:AssumeRole` grant at all | the **single-account model** generalizes it to the whole control plane |
| 3. Own infra account | the institution runs its own hub; cross-account trust is fine because both ends are theirs | the **organization model** |

### Principles

- **P1. Pull, never push.** The institution installs and upgrades. spore.host
  publishes artifacts and holds no credential, role or trust in any institutional
  account. A GitHub OIDC deploy role in an institutional account would be exactly the
  external trust P2 forbids. In an Amazon-internal account it would also trip the
  external-access detector that denied a trust in 12 minutes on 2026-09-26.
- **P2. No trust outside the institution.** Every trust policy the bundle or the CLIs
  create names a principal in the same account or the same AWS Organization, and the
  code checks that before creating it ([§6.3](#_6-3-the-trust-guard-hard-constraint)).
- **P3. Fail closed.** In institutional mode no code path talks to a spore.host-operated
  endpoint unless the descriptor names it. Today a named launch registers a public DNS
  record with spore.host's updater by default (`--name` implies `--dns`,
  `cmd/launch_config.go:298-302`). For an institution that is data leaving to a third
  party, so it must be impossible, not merely configurable.
- **P4. Everything installed has a named deleter**, and teardown is tested
  ([§4.6](#_4-6-teardown)). This continues "leave no trace" and spore-host#610.
- **P5. The installer provisions IAM; users do none.** Every role and policy a feature
  needs is in the bundle. The institution only *assigns* the policies spore.host ships,
  to its people.
- **P6. One version per deployment, and skew is visible.** Version skew between CLIs
  and the control plane is today's normal state. Here it is expected, bounded by a
  compatibility window, and reported by `spawn doctor`.
- **P7. No NAT gateway, no mirrors of third-party artifacts** (the owner's rule;
  spawn#1515). Hosting spore.host's *own signed* artifacts in the institution's
  buckets is a distribution point, not a mirror, and is justified in [§10](#_10-distribution).

---

## 3. What exists today

### 3.1 Components

Measured on 2026-10-11 in spawn's `docs/infra-account.md`, 90 control-plane resources
in 966362334030. Triaged for an institution (the first deliverable spawn#780 asked for):

| component | source | institution needs it? | where it runs |
|---|---|---|---|
| spored binaries (`spawn-binaries-<region>` ×11) | spawn release workflow | **required** (or reuse spore.host's, where policy allows) | hub, one bucket per allowed region |
| ttl-reaper | `spawn/lambda/ttl-reaper` | **required**: the lifecycle invariant's backstop | each member account (in-account mode, as `spawn reaper deploy`), or the hub (D8) |
| sweep-orchestrator + `spawn-sweep-orchestration` + sweeps bucket | `spawn/lambda/sweep-orchestrator` | **required** for detached sweeps, the default sweep mode | hub |
| scheduler-handler + `spawn-schedules`, `spawn-schedule-history` + schedules buckets | `spawn/lambda/scheduler-handler` | optional (`spawn schedule`) | hub |
| pipeline-orchestrator + table + bucket | `spawn/lambda/pipeline-orchestrator` | optional (`spawn pipeline`) | hub |
| dns-updater + Route53 zone | `spawn/lambda/dns-updater` | optional (instance DNS names; DCV/web TLS) | hub |
| dashboard-api, dashboard-websocket(+processor), API Gateway, `spawn-user-accounts`, `spawn-teams`, `spawn-team-memberships`, `spawn-ws-tickets`, `spawn-websocket-connections` | `spawn/lambda/dashboard-*` | required for the portal and teams | hub |
| portal static site (`web/app`) | umbrella `web/` | optional, but expected by most institutions (#651 guided GUI) | hub (S3 + CloudFront) |
| cost-history-collector + `spawn-cost-history` | `spawn/lambda/cost-history-collector` | required for chargeback (#277) | hub |
| spore-bot + `spore-bot-*` tables + Function URL | umbrella `lambda/spore-bot` | optional (Slack/Teams/Discord/SMS) | hub |
| rest-api + `spore-api-keys`, `spore-sms-pending` | umbrella `lambda/rest-api` | optional (Python SDK, SMS replies) | hub |
| lagotto capacity-poller + `lagotto-*` tables | lagotto | optional; already per-account (`lagotto deploy`/`setup`) | each member account |
| egress proxy | `spawn/pkg/egressproxy` | optional (private subnets) | each VPC, on demand, idle-expiring |
| `spawn-availability-stats` | `spawn/pkg/availability` | optional | hub |
| portal-phone-home, account-prober, `spore-portal-accounts`, onboarding role | umbrella | **not needed**: BYOA onboarding for the hosted portal. An institution's accounts join through the organization (StackSets) instead | none |
| prism-bot, `spawn-ts-portal` | prism; spawn-ts | not needed (`spawn-ts-portal`'s role in an institution is an open question, Q7) | none |
| spored signing key (KMS) | spore.host release | operator-only. Institutions verify against it; they don't hold it | spore.host only |
| docs site | umbrella `docs/` | not needed (docs.spore.host serves everyone; a copy is optional) | none |

### 3.2 Configuration mechanisms that already exist

There are four, and they overlap. That overlap is itself refactoring item R2.

1. `spawn/pkg/config/endpoints.go`: environment variables (`SPORE_NOTIFY_URL`,
   `SPORE_DNS_URL`, `SPORE_BOT_LAMBDA_ROLE_ARN`, `SPORE_PORTAL_PHONE_HOME_*`, …) over
   compiled-in maps keyed by `SPORE_ENV` (`integ`/`prod`). Both keys point at the same
   hosted URLs.
2. `spawn/pkg/config/infrastructure.go` + `pkg/infrastructure/resolver.go`: an
   `infrastructure.mode: shared | self-hosted` block in `~/.spawn/config.yaml` with
   table, bucket-prefix and Lambda-ARN overrides. Only `cmd/launch_single.go:343` and
   `cmd/validate.go` read it; the sweep, schedule and status paths don't.
3. `libs/sporeconfig`: profile, region, account and output, resolved flag > env > file
   > default, in `~/.config/spore/config.toml`. Adopted by spawn, truffle and lagotto.
4. SSM `/spawn/dns/{domain,api_endpoint,function_arn}` in the launch account and region
   (`spawn/pkg/config/config.go:82-84`): **the only zero-config, account-level
   discovery today, and the precedent for the descriptor.**

### 3.3 The reference deployment's state

- `infra/DEPLOY.md` is a manual runbook for 812107987990 covering Route53, the
  dns-updater, rest-api and an API key. **Step 3 tells the operator to create the
  dns-updater Function URL with `--auth-type NONE` and `--principal '*'`**
  (`infra/DEPLOY.md:215-227`). The [self-hosting guide](../guides/self-hosting.md)
  says never to do that, because the updater relies on SigV4 to know who is calling.
  The runbook must be fixed before anyone follows it (R29).
- #644 records that there is no working access to 812107987990 yet (via #392). This
  design therefore can't say what, if anything, is deployed there.
- #274 is **closed, but its acceptance criteria aren't met**. Hosted values became
  *overridable*; they weren't removed. Account IDs, Lambda URLs and table names are
  still compiled in ([Appendix A](#appendix-a-hardcoded-value-inventory)).
- `docs/guides/self-hosting.md:262` still names `spore-host-dev` as the compute
  default (#636).

---

## 4. Installation, delivery, upgrades, teardown

### 4.1 Deployment models

**Model S: single account (recommended first; D1).** Hub and compute are one account.

- There is no cross-account role anywhere. As with `spawn reaper deploy` today, the
  absence of `sts:AssumeRole` grants is a property a test asserts (spawn#780's
  constraint), so a security reviewer can quote it.
- The CLI's "infra" and "compute" credentials are the same, which removes the CLI-to-hub
  access problem (D6) entirely.
- It fits a department, a lab, a company team, and the reference deployment.

**Model O: organization (hub plus members).** One hub account and N member accounts, all
in the institution's AWS Organization.

- Member accounts get a *member baseline* stack through CloudFormation StackSets with
  service-managed permissions, auto-deployed to every account in the chosen OUs,
  including new ones.
- Cross-account trust exists, but only from member to hub, only to fixed role names,
  and only with an organization guard ([§6.3](#_6-3-the-trust-guard-hard-constraint)).

What goes where:

| | hub account | member account (baseline stack) | single account |
|---|---|---|---|
| descriptor (SSM `/spore/deployment`) | yes | yes, every allowed region | yes |
| Route53 zone + dns-updater | yes | DNS invoke grant on the instance role | yes |
| sweep/scheduler/pipeline orchestrators + tables + buckets | yes | `SpawnSweepCrossAccountRole` (spawn#1537) | yes, no cross-account role |
| dashboard-api + API + portal + identity broker | yes | read role for the hub (`SpawnDashboardCrossAccountReadRole`) | yes |
| cost collector + chargeback exporter | yes | cost read role | yes |
| spore-bot / rest-api (optional) | yes | bot role / rest-api role (#377) | yes |
| binaries buckets | yes, shared to the org by bucket policy | none | yes |
| ttl-reaper | optional hub mode (D8) | **yes, in-account (recommended)** | yes |
| lagotto poller | none | `lagotto deploy`/`setup`, unchanged, or folded into the baseline (D15) | yes |
| spored instance role/profile, `spore-user` managed policy | none | yes | yes |
| egress proxy | none | on demand, per VPC, by the CLI (not in a stack) | on demand |

### 4.2 Installation tooling (D2)

| option | for institutions | against |
|---|---|---|
| **CloudFormation templates + StackSets** | native; no state backend; change sets fit change control; StackSets auto-deploy member baselines to new accounts; Service Catalog, Control Tower customizations and AFT all consume it; stack deletion is a deleter | the project's CFN traps: parameters reset to defaults (#650), SAM's `Enabled: !Ref` bug, CFN-generated role names (#476), `--migrate-from-cloudformation` (lagotto#226) |
| CDK | generates CloudFormation | `cdk bootstrap` puts broad roles in every account, which institutions resist; adds a Node toolchain |
| Terraform / OpenTofu | common at universities; spore.host's own infra already uses OpenTofu (`infra/tofu`) | the state backend becomes the institution's problem; no native auto-deploy to new member accounts; the existing modules are import-onto-live for 966362334030 with the account ID compiled in |
| `spawn infra deploy` (direct SDK calls, like `lagotto deploy` after lagotto#154, `spawn reaper deploy` and the egress proxy) | no CloudFormation traps; one Go implementation; tag-based teardown already proven | opaque to change review; no drift detection; no org-wide fan-out; every institution's reviewers would have to read Go |

**Recommendation.** CloudFormation is the *artifact of record*. The templates are
generated from code, linted, tested, versioned and signed with each release. On top of
it:

- **`spawn infra plan | apply | status | upgrade | teardown`**, a thin wrapper. `plan`
  creates a change set and prints it. `apply` executes the reviewed change set. Before
  and after every apply it snapshots stack parameters and live configuration and diffs
  them, following the verify-against-AWS rule from the reaper incidents. The wrapper is
  optional: an institution may run the templates through its own pipeline instead.
- **StackSets** for the member baseline in Model O.
- **A Terraform/OpenTofu module that wraps the same templates**
  (`aws_cloudformation_stack` / `aws_cloudformation_stack_set`), so there is one
  definition to keep correct, not two.
- **The direct-SDK installers stay** for individual users in hosted mode (shape 2).
  In institutional mode they detect a stack-owned copy, through an ownership tag
  `spore:installed-by=stack/<deployment_id>`, and refuse to install a competing one
  (R18).

**The CloudFormation traps are design inputs.** The templates use no SAM transform, fixed
role names, `State` rather than `Enabled: !Ref`, and a complete parameter file on every
deploy, gated in CI the way #779 gates the reaper. Every IAM policy gets one real
`PutRolePolicy` against a throwaway role in CI: `${aws:PrincipalAccount}` passed every
simulator in #1069 and failed only there.

### 4.3 The bundle

One bundle per release, named `spore-deployment-<version>`:

```text
spore-deployment-0.NNN.0/
  manifest.json          # every artifact: path, sha256, component, version, API level
  manifest.json.sig      # cosign bundle, same signing identity as the CLIs (#344)
  templates/
    hub.yaml             # hub account (also used for single-account)
    member-baseline.yaml # member account (StackSet target)
    parameters.schema.json
  lambda/*.zip           # every Lambda the templates reference, reproducible builds
  portal/                # prebuilt web/app; reads its config at runtime (R22)
  terraform/             # wrapper module around templates/
```

- Today spawn's Lambdas are versioned with spawn and the umbrella's (rest-api,
  spore-bot) are not: the umbrella deploys continuously and isn't tag-released. The
  bundle needs both, so the umbrella has to publish versioned Lambda and portal
  artifacts (R16).
- The bundle's version is spawn's release version, since most components live in
  spawn. Other components carry their own version inside `manifest.json`.

### 4.4 Versioning, upgrades and skew

- **The deployment has one version**, recorded in the descriptor and as a
  `spore:deployment-version` tag on every stack. Lambdas keep their `spawn:version`
  stamp (#768).
- **The control-plane API level.** An integer each Lambda reports, in a response
  header or a `/version` route. A client declares the range it supports.
- **Compatibility window (D14).** A CLI release supports control-plane API levels N
  and N-1. Institutions upgrade in change windows (often quarterly), so the CLI they
  install from Homebrew will often be newer than their control plane. Outside the
  window the CLI refuses the affected feature and says which upgrade is needed. It
  doesn't half-work.
- **Skew is reported, not hidden.** `spawn doctor` and `spawn infra status` print the
  CLI version, the deployment version, each component's stamped version, and the
  verdict. This extends `spawn reaper status`, which already prints both versions.
- **An upgrade is a change set.** `spawn infra upgrade --to <version>` downloads and
  verifies the bundle, builds a change set against the live stacks, and prints it with
  the release's deploy checklist (#1444), which already classifies each component as
  code-only or manual. Nothing applies without the installer's approval.
- **Rollback** is a change set back to the previous bundle. Data migrations must be
  forward-compatible across one version, so a rollback never needs a reverse
  migration.
- **spored** on running instances keeps its version. New launches pick up the
  deployment's spored. `spawn upgrade-spored` stays operator-initiated.

### 4.5 Order of installation

Model S:

1. Phase 0 discovery (#273) and the readiness checklist ([§13](#_13-readiness-checklist-phase-0)).
2. DNS: create the zone and delegate it from the parent (needs the parent zone's owner).
3. Identity: register the portal application with the IdP. **Midway prod has a
   security-review lead time, so start it first.**
4. `spawn infra plan` on `hub.yaml` with the parameter file, then review and apply.
5. `spawn binaries sync` copies the release's signed spored artifacts into the
   institution's buckets (R8).
6. Write the descriptor (the stack writes the SSM parameter) and check it with
   `spawn doctor --deployment`.
7. Assign the `spore-user` managed policy to the people or groups who launch.
8. Run the smoke tests: launch with a short TTL, check DNS, confirm the reaper's
   dry-run report, arm the reaper, and check that the TTL terminates the instance and
   removes its DNS record.

Model O adds, after step 4, a StackSet for `member-baseline.yaml` targeted at OUs, and
step 6 runs in every member account and region.

### 4.6 Teardown

Every resource class has a named deleter:

| resource class | created by | deleter | data retained? |
|---|---|---|---|
| hub stack resources (Lambdas, roles, tables, APIs, alarms, log groups) | `hub.yaml` | stack delete, run by `spawn infra teardown` | tables with data: export first, or `--retain-data` sets `DeletionPolicy: Retain` per table |
| buckets (binaries, sweeps, schedules, pipelines, portal, chargeback exports) | `hub.yaml` | `spawn infra teardown` empties buckets tagged `spore:deployment=<id>`, then deletes the stack | chargeback exports are retained if `--retain-data` |
| member baseline | StackSet | StackSet instance delete (OU removal triggers it automatically) | none |
| Route53 zone | `hub.yaml` | stack delete, after all records are gone; the parent's NS delegation is printed for the installer to remove | none |
| instances, volumes, FSx, SGs, key pairs created by launches | spawn | TTL plus the reaper; `spawn cleanup` | n/a |
| per-launch IAM roles (`spawn-instance-<hash>`) | spawn at launch | **none today** (#610). In institutional mode, prefer pre-provisioned roles (R9), which leaves nothing to delete | n/a |
| `spawn-results-*`, `spawn-staging-*` buckets | `task run` | retention and lifecycle (spawn#1076) plus `spawn cleanup` | per lifecycle |
| egress proxy | spawn on demand | idle expiry (72 h default), plus `spawn cleanup` | n/a |
| lagotto poller | `lagotto deploy` | `lagotto teardown` | n/a |
| identity: IdP app registration, Identity Center assignments | the installer | the installer (documented step; spore.host cannot delete in the IdP) | n/a |
| CloudTrail, cost and usage exports | the institution | the institution | yes, by their policy |

Teardown is tested in CI against a scratch account, or substrate where it models the
calls. The test asserts that `spawn footprint` reports zero resources tagged
`spore:deployment=<id>` afterwards.

---

## 5. Identity

### 5.1 Principle: IAM is the authorization plane

spore.host already treats AWS credentials as the user's identity. The CLIs use the
standard credential chain. The new portal federates the user straight into AWS through
`AssumeRoleWithWebIdentity` (Globus today, `infra/tofu/portal-oidc`). The dashboard-api
checks the caller against STS and acts *as the caller* (`spawn/lambda/dashboard-api/cross_account.go`, #815).

This design keeps that model and finishes it:

- **The institution's IdP federates people into AWS.** spore.host never sees a password
  and normally never validates an IdP token itself.
- **The person** is the role session's **source identity** (`sts:SourceIdentity`). It is
  set at federation, survives role chaining, and appears in CloudTrail. It replaces the
  ad-hoc `callerARN`/email linkage that makes the portal and CLI see different people
  today (#531).
- **The team** is a **principal tag** (`spore:team`, plus optional `spore:project` and
  `spore:cost-center`), set from IdP group claims at federation.
- **Enforcement** is IAM ABAC in the shipped `spore-user` policy:
  `ec2:RunInstances` and `ec2:CreateTags` require `aws:RequestTag/spawn:team` to equal
  `${aws:PrincipalTag/spore:team}`. A team label is then a fact, not a claim, which is
  what chargeback (#277) needs. Before shipping, this needs a real `PutRolePolicy` and a
  real `RunInstances` test.

### 5.2 CLI sign-in

| path | when | notes |
|---|---|---|
| `aws login` | the documented default ([AWS authentication](../guides/aws-auth.md)) | Phase 0 item 1 checks that it works with the institution's console federation path. If it doesn't, the CLIs need no change: any credential-chain source works |
| IAM Identity Center | institutions that use it (common) | permission sets carry the `spore-user` policy; *attributes for access control* map IdP attributes to the `spore:team` principal tag |
| SAML into IAM roles | institutions without Identity Center | the SAML assertion sets `PrincipalTag:spore:team` and `SourceIdentity` |
| static keys | CI only | discouraged; the deployment-packet language applies |

### 5.3 Portal sign-in (D4)

| option | how it works | fits | against |
|---|---|---|---|
| **A. IAM OIDC provider, direct** (today's Globus pattern) | browser does OIDC, then `AssumeRoleWithWebIdentity` into a portal role | OIDC IdPs that can emit the `https://aws.amazon.com/tags` claim (Okta, Entra ID can) | IAM's generic OIDC provider exposes only `aud`/`sub` as condition keys (`infra/tofu/portal-oidc/main.tf` notes this), so without the tags claim group-to-team mapping is impossible; SAML-only IdPs can't use it |
| **B. Cognito identity pool as broker (recommended)** | browser does OIDC or SAML with the institution's IdP; the identity pool maps claims to roles (rule-based) and to principal tags (attributes for access control) | OIDC **and** SAML (Shibboleth/ADFS); group claims to team without IdP-side tag configuration; the legacy dashboard already uses an identity pool | one more managed service in the hub; Cognito must be allowed by SCPs (Phase 0 item 3) |
| C. Lambda validates the IdP's JWT (#275 as written) | the portal sends the IdP token; Lambdas validate it against JWKS | IdPs whose tokens can't reach AWS at all | a second authorization plane beside IAM; the portal could no longer act as the user in AWS; every Lambda grows auth code |

**Recommendation: B, with A allowed** when the IdP is OIDC and emits session tags. C is
not recommended. #275's goals (configurable issuer, Midway integ then prod switchable by
one parameter, Cognito unchanged for hosted) are all met by B with the issuer as a stack
parameter.

### 5.4 Per-IdP notes

| IdP | protocol | team source | notes |
|---|---|---|---|
| Midway (reference) | OIDC | group claims, via B; or Midway's own access policy as the gate | start on integ (decided on #275); prod needs a security review, so register early. Group claim names and shape are Phase 0 facts |
| Okta | OIDC or SAML | groups claim, or the `https://aws.amazon.com/tags` claim (A) | Identity Center integration via SCIM is common |
| Microsoft Entra ID | OIDC or SAML | groups claim (object IDs, not names: needs a mapping table) or app roles | past a group limit (about 150 in SAML, 200 in JWTs) Entra drops the groups claim, so prefer app roles |
| Shibboleth / InCommon (universities) | SAML | `eduPersonEntitlement` or `isMemberOf` | needs B (SAML). CILogon or Globus Auth can bridge InCommon to OIDC, and Globus already works with the portal |
| Google Workspace | OIDC or SAML | groups need the Directory API; prefer SAML with custom attributes | |
| IAM Identity Center as the IdP | OIDC/SAML out | Identity Center groups | the simplest path when an institution already uses it for the console |

### 5.5 Teams

- **The default source of truth is the IdP group**, mapped to a principal tag. The
  spore.host teams tables (`spawn-teams`, `spawn-team-memberships`) remain for
  institutions without usable group claims, and for ad-hoc sharing within a team.
- **Mapping configuration** (`group → team`, plus the default team) is a hub stack
  parameter, read by the identity broker's rules and by the CLI's `spawn doctor`.
- **Keying.** Team membership is keyed by source identity, which fixes #531's split
  between portal and CLI identities.

### 5.6 Backend authentication

- **API calls are SigV4 (API Gateway IAM auth).** The portal already has AWS
  credentials, so it signs. The CLI already has them. This retires the
  `X-AWS-Credentials` header (base64 credentials in a header, validated by an STS call
  per request) in favour of the standard mechanism.
- **API keys** (rest-api, the Python SDK) remain for headless use, but every key is
  bound to a principal and team at issue time (#588 needs an issuance path anyway).
- **The legacy dashboard** (`web/dashboard.html`, `web/js/*` with Cognito, Google and
  GitHub logins and 15 hardcoded `api.spore.host` URLs in `web/js/main.js` alone) is
  not shipped in the bundle. Whether to retire it for hosted spore.host is D17.

---

## 6. Tenancy and isolation

### 6.1 Models (D7)

| model | isolation | chargeback | quotas | when |
|---|---|---|---|---|
| **T1. Shared account, ABAC by team** | IAM tag conditions plus the existing project-tag gating (#376) | by tag (needs cost-allocation tags activated) | shared: one team can exhaust the account's GPU quota | companies, small departments, the reference deployment |
| **T2. Account per team (or per grant)** | account boundary | by account: needs no tags, and finance already understands it | per team, but each account's quotas must be raised | universities, where grants pay per lab; regulated data |
| **Hybrid** | account per department, tags per project | both | per department | large institutions |

The design supports all three with the same artifacts: T1 is Model S or one member
account; T2 is Model O. **The recommended default is T1 for the reference deployment and
T2 for universities.**

### 6.2 Hub-to-member access (#377)

In Model O the hub's Lambdas act in member accounts. #377 proposed AssumeRole per API
key for the rest-api. This generalizes it to every hub function that touches members:

| hub function | member role | assumed as | today |
|---|---|---|---|
| sweep-orchestrator | `SpawnSweepCrossAccountRole` | the Lambda's role, for detached sweeps | role created by a manual script only (spawn#1537) |
| dashboard-api | `SpawnDashboardCrossAccountReadRole` | **the caller** (#815: no standing cross-tenant read) | role ARN hardcoded to 435415984226 (`lambda/dashboard-api/cross_account.go:54`) |
| rest-api | `SporeRestApiRole` (#377) | the Lambda, scoped by the key's account | no AssumeRole path at all |
| spore-bot | `SpawnBotCrossAccount` | the Lambda, per-account ExternalId (#374) | exists |
| ttl-reaper (hub mode only, D8) | `spawn-ttl-reaper-ec2` | the Lambda | exists for 435415984226 |
| cost collector | `SporeCostReadRole` | the Lambda | single account only |

Rules for every member role:

- a fixed role name and path (`/spore/`), never CloudFormation-generated (#476);
- a trust policy naming the exact hub role ARN, **with** `aws:PrincipalOrgID` equal to
  the institution's organization;
- inside one organization an ExternalId adds nothing, so it is optional. For the bot it
  stays (#374's per-account model), because a bot registration can come from a
  workspace the institution doesn't control;
- least privilege, tag-scoped to `spawn:managed=true` where the action allows;
- project and team tag gating stays on top, as defence in depth (#377's note).

### 6.3 The trust guard (hard constraint)

Every code path that creates or updates a trust policy goes through one guard: the
bundle's template generator, `spawn infra`, `spawn notify register`, `spawn onboard`,
`spawn reaper deploy`, and the sweep role setup that replaces the script (spawn#1537).
The guard:

1. **refuses to create anything in 942542972736**, whatever the mode;
2. in institutional mode, **refuses any trusted principal in 966362334030 or
   435415984226**, or any other spore.host-operated account;
3. in institutional mode, **refuses any cross-account trusted principal** unless the
   trusting and trusted accounts report the same organization ID
   (`organizations:DescribeOrganization`, run with each side's credentials). If either
   side can't read it, the guard fails closed and says why;
4. refuses `Principal: "*"` and any Function URL with `AuthType: NONE`;
5. is enforced by a repository test in the style of `account_boundary_test.go`, which
   fails the build if any template or code path can emit a trust without passing the
   guard.

The guard also prints, before any cross-account change, the output of
`describe-organization` from both sides. That is the check the 2026-09-26 incident
showed must come first.

### 6.4 Data isolation in the hub

Hub tables hold records from every team. Each record carries the owning source
identity, team and account. Reads are scoped server-side to the caller's verified
principal and tags, never to a client-supplied ID, which matches the fail-closed
ownership fixes from the 2026-06 audit. Where a table is read by the CLI directly (D6),
DynamoDB resource policies with `dynamodb:LeadingKeys` conditions do the scoping.

---

## 7. Configuration and discovery

### 7.1 The deployment descriptor

One JSON document, schema `spore.host/deployment/v1`, published with a JSON Schema in
libs so the Go CLIs, the TS ports and the portal share one shape (as #646 does for
parity). A sketch:

```json
{
  "schema": "spore.host/deployment/v1",
  "deployment_id": "acme-research",
  "version": "0.170.0",
  "api_level": 3,
  "mode": "institutional",
  "organization_id": "o-example",
  "hub_account": "111122223333",
  "home_region": "us-east-1",
  "allowed_regions": ["us-east-1", "us-west-2"],
  "endpoints": {
    "api": "https://api.spore.example.edu",
    "portal": "https://spore.example.edu",
    "dns": { "domain": "spore.example.edu", "zone": "public",
             "function_arn": "arn:aws:lambda:us-east-1:111122223333:function:spawn-dns-updater",
             "url": "https://abc.lambda-url.us-east-1.on.aws/" },
    "notify": null,
    "rest_api": null
  },
  "binaries": { "bucket": "acme-spore-bin-111122223333-{region}", "fallback_region": "us-east-1",
                "extra_signing_keys": [] },
  "launch": {
    "subnets": { "us-east-1": ["subnet-0aaa", "subnet-0bbb"] },
    "security_groups": { "us-east-1": ["sg-0ccc"] },
    "connect": "ssm",
    "inbound_cidrs": [],
    "egress": "spore-proxy"
  },
  "iam": { "permissions_boundary": "arn:aws:iam::111122223333:policy/Boundary",
           "role_path": "/spore/", "role_prefix": "spore-",
           "instance_profile": "spore-spored" },
  "tags": { "required": { "CostCenter": "${spore:cost-center}" }, "team_tag": "spawn:team" },
  "features": { "bot": false, "rest_api": false, "sweeps": true, "schedules": true }
}
```

A `null` endpoint means **off**. Nothing falls back to spore.host.

### 7.2 Where it is published, and resolution order

1. A flag or environment variable naming a descriptor file or URL (`--deployment`,
   `SPORE_DEPLOYMENT`): for testing, and for CI.
2. `~/.config/spore/config.toml`, a `[deployment]` table (sporeconfig, R1). It can pin a
   `deployment_id`, to catch the wrong account.
3. **SSM `/spore/deployment` in the caller's account and region.** Written by the hub
   stack and the member baseline. This needs zero configuration from users: a researcher
   whose credentials land in an institutional account is in institutional mode
   automatically. The SSM standard tier holds 4 KB; larger descriptors go to the advanced
   tier, or SSM holds a pointer (an S3 URI plus sha256).
4. `https://<portal>/.well-known/spore-deployment.json`, for the browser portal and for
   clients outside AWS.
5. None found: hosted mode, exactly as today.

- **Fail-closed rule.** If SSM `/spore/deployment` exists but can't be read, the client
  refuses and says which permission is missing. It doesn't silently drop to hosted mode,
  the way #1121 once did for `/spawn/dns/*`.
- **Compatibility.** `/spawn/dns/*` keeps working. The descriptor's DNS block takes
  precedence when both exist and they disagree, and `spawn doctor` warns about the
  disagreement.
- **`SPORE_ENV` (`integ`/`prod`) is deprecated.** Integ versus prod becomes two
  deployments with two descriptors.

### 7.3 Naming policy (D3)

| kind | scope | policy | examples |
|---|---|---|---|
| DynamoDB tables, Lambda functions, IAM roles, log groups, EventBridge rules, SSM names | account (and region) | **fixed names**, the same as hosted; one deployment per account | `spawn-sweep-orchestration`, `spawn-ttl-reaper-production`, `spore-bot-role` |
| S3 buckets | global | **parameterized**: `<prefix>-<account>-<region>`, prefix from the stack | binaries, sweeps, schedules, pipelines, portal |
| domains | global | parameter | `spore.research.wwps.aws.dev` |
| ARNs of another account's resources | n/a | resolved from the descriptor, never compiled in | hub role ARNs, dns function ARN |

#276 proposed deriving *every* name from a `StackName` prefix. That buys several
deployments per account, but needs every table and function name threaded through every
Lambda and CLI path (Appendix A lists about 30 table-name constants alone). One
deployment per account is the cleaner institutional pattern anyway: staging and prod are
different accounts. The fixed-name policy is recommended. If the owner wants multiple
deployments per account later, the descriptor already carries a `control_plane.tables`
override block, so it can be added without a schema break.

### 7.4 Hardcoded values

The full inventory, with file and line, is [Appendix A](#appendix-a-hardcoded-value-inventory).
In summary:

| category | where | count (non-test) |
|---|---|---|
| spore.host account IDs in Go code | spawn `pkg/config`, `pkg/infrastructure`, `lambda/dashboard-api`, `lambda/scheduler-handler`, `scripts/deploylambdas` | 9 sites |
| account IDs in scripts, templates, workflows | spawn (18 files), umbrella (`infra/tofu`, `scripts/`, `web/`, workflows) | about 50 sites |
| Lambda Function URLs | spawn `pkg/config/endpoints.go` (3 URLs, 6 lines); umbrella `web/.env.production`, `deployment/cloudformation/portal-onboarding-role.yaml`, `sdk/python`; python-sdk | 10 lines |
| API Gateway URLs, Cognito and OAuth client IDs | umbrella `web/js/*`, `web/dashboard.html`, `web/app/config.ts`, `web/.env.production`; spawn `lambda/dashboard-api/slack_oauth.go` | about 25 lines |
| profile names `spore-host-infra` / `spore-host-dev` | spawn `pkg/config/endpoints.go:50` (functional) plus about 25 scripts; umbrella about 25 scripts | 1 functional default, about 50 script defaults |
| `spawn-binaries-*` URLs and grants | spawn bootstrap, app, upgrade, pipeline, Windows install, IAM; spawn-ts | about 25 sites |
| `.spore.host` composed into DNS names or certificates | spawn (10 sites), umbrella spore-bot (2), spawn-ts (4) | 16 sites |
| control-plane region pinned to `us-east-1` | spawn `cmd/` (13 sites) | 13 sites |
| fixed table names | spawn (about 30), umbrella (6), lagotto (3) | fixed by policy, not a defect |
| CloudFront distribution and state bucket | umbrella `web/deploy.sh`, `deploy-site.yaml`, `infra/tofu/*` | operator-only; not shipped |

lagotto, truffle, libs and spore-host-mcp have **no** functional hardcoding of
spore.host infrastructure. lagotto already installs per-account. truffle's
`pkg/spawn/regions.go` list of spored regions is the cross-repo drift spawn#20 tracks.

---

## 8. Networking

### 8.1 Institutional VPCs

Institutions usually provide the VPC: often no default VPC, private subnets, and
centrally managed endpoints and egress.

- **The descriptor names launch subnets and security groups per region** (`launch.*`),
  and every launch path uses them: single, array, sweep, pool, app, MPI cohort, and
  lagotto's spawn and hold actions. This closes the default-subnet gaps (spawn#1476,
  lagotto#256) for institutions generally.
- **Inbound default: none.** `connect: ssm` makes `spawn connect` use Session Manager,
  and spawn creates no security group with ingress. Today several paths open SSH, DCV
  or HTTPS to `0.0.0.0/0` (`spawn/pkg/aws/securitygroup.go:91`, `:220`, `:432-494`,
  `:550`). AWS Config's `restricted-ssh` and Security Hub's EC2 controls would flag those,
  or auto-remediate them in the middle of a session. Where inbound is needed, the
  descriptor's `inbound_cidrs` is the only source of CIDRs.
- **Public IPs** follow the subnet. `--no-public-ip` becomes the institutional default
  when the subnets are private.

### 8.2 Egress (no NAT, no mirrors)

| need | resolution |
|---|---|
| AWS APIs (EC2, SSM, S3, STS, logs, …) | VPC endpoints. spawn's `pkg/aws/private_network.go` already lists every service a private instance needs and why; `spawn doctor` reports missing ones |
| spored binary | the institution's own bucket, through the S3 gateway endpoint ([§10](#_10-distribution)) |
| DNS registration | **Function URLs have no VPC endpoint** (`private_network.go` says so). Add a `lambda:InvokeFunction` path for spored, which works through the Lambda interface endpoint and cross-account with a resource policy (R13) |
| third-party installs (AWS CLI on Ubuntu, EFA installer, apt/dnf) | the spore.host-managed egress proxy (spawn#1515: opt-in, per VPC, idle-expiring), **or the institution's own proxy** if it has one (D11). No NAT gateway, no mirror |
| air-gapped (no egress at all) | a golden AMI with the dependencies baked in, plus VPC endpoints. Out of scope before 1.0 except as a documented limitation (D16) |

Many institutions already run a mandatory egress proxy. Launching a second, spore.host
proxy beside it would be refused by their network team. So the descriptor takes
`egress: "https://proxy.example.edu:3128"`, and spored and the bootstrap use it the way
they use the managed proxy today. That is D11, because it widens the owner's
"spore.host-managed proxy" rule to "a proxy, ours or theirs".

### 8.3 DNS

- **The zone** lives in the hub, delegated from the institution's parent zone.
  Delegation needs the parent's owner, which is a Phase 0 fact.
- **Public or private (D12).** A public zone publishes instance IPs. For many
  institutions private IPs in a public zone are a finding. The descriptor's
  `dns.zone: private` makes the updater write to a Route53 private hosted zone associated
  with the institution's VPCs, so names resolve only on the network. The default is
  **off unless configured**: in institutional mode `--name` stops implying DNS
  registration unless `endpoints.dns` is set.
- **Callers.** The updater's resource policy uses one `aws:PrincipalOrgID` statement in
  place of today's per-account allowlist. Lambda resource policies support that
  condition. Whether a Function URL's `AuthType: AWS_IAM` honours it as expected needs a
  live test.
- **TLS for DCV and web apps.** Today the wildcard certificate is
  `*.<account-base36>.spore.host`, issued manually (#295). In institutional mode it is
  `*.<account-base36>.<domain>`, issued by the hub with renewal automated (#295
  parameterized). For a private zone, ACM's DNS validation needs a public validation
  record, or the institution's private CA (ACM PCA), which is a Phase 0 fact.

### 8.4 Data perimeters

Institutions with an AWS data perimeter deny S3 access to buckets outside their
organization (`aws:ResourceOrgID` in SCPs or VPC endpoint policies). Under such a
policy **spored can't download from spore.host's public `spawn-binaries-*` buckets at
all**. This is the main reason binaries must be hostable in the institution's own
buckets ([§10](#_10-distribution)). The same applies to the catalog's public ECR images.

---

## 9. Cost, governance and compliance

### 9.1 Chargeback (#277)

There are two sources, and the report labels which is which. That is the
static-pricing labelling rule applied to cost.

| source | what | latency | trust |
|---|---|---|---|
| **estimate** | spored's `spawn:compute-seconds` × `spawn:price-per-hour`, plus `spawn:cost-footprint` (instance tags; cost-history-collector) | minutes | approximate: on-demand list price, ignores discounts, Savings Plans and credits; static prices carry their date and reason |
| **billed** | AWS Data Exports (CUR 2.0) or Cost Explorer `GetCostAndUsage`, grouped by the `spawn:team` and `spawn:project` cost-allocation tags, or by account in T2 | 24–48 h | what finance reconciles against |

- **`spawn cost report --since --until --group-by team|project|account|user -o table|json|csv`**
  shows both columns, the difference, and a label. #277's JSON shape is kept, with
  `estimated_usd` and `billed_usd` fields in place of one `total_cost_usd`.
- **A scheduled exporter** (in the hub) writes the monthly report to the institution's
  bucket. Finance systems (Apptio and others) import the CSV.
- **Cost-allocation tags must be activated in the organization's management account.**
  spore.host can't do that from a member or hub account. It is a documented installer
  step, and `spawn doctor` checks it where it can (`ce:ListCostAllocationTags`).
- **D13**: billed cost is the recommended source of truth for chargeback, with the
  estimate for real-time guardrails (`--cost-limit`, lagotto exposure).

### 9.2 Budgets

- **Per-instance**: `--cost-limit` (spored) and the TTL. Unchanged.
- **Per-team** (optional): an AWS Budget per team tag, or per account in T2, created by
  the hub stack from the team map. It alerts by default. A budget action (applying a
  deny policy) is opt-in, because it stops launches.
- **Per-deployment defaults** in the descriptor: maximum TTL, maximum instance size, and
  an allowed instance-family list. The CLI enforces them before launch, and the
  `spore-user` policy enforces the same limits in IAM where IAM can express them
  (`ec2:InstanceType` conditions).

### 9.3 Tagging policy

- **Required tags.** The descriptor's `tags.required` is applied to *every* resource the
  suite creates: instances, volumes, ENIs, security groups, key pairs, roles, instance
  profiles, buckets, queues, FSx, Lambdas and log groups. Values can reference principal
  tags (`${spore:cost-center}`). This is what Organizations tag policies and Config's
  `required-tags` check for.
- **The tag budget.** EC2 allows 50 tags per resource and spawn already writes many.
  spawn#1245 found five that nothing reads. Institutional tags compete for the same
  slots. The launch path must count them and refuse, naming the tags, rather than fail
  at `CreateTags`.
- **Tag policies with enforced values** can reject spawn's own keys on some resource
  types. Phase 0 item 6 records them, and the bundle documents the exemption to request.

### 9.4 SCP compatibility

The CLIs must work under the SCPs institutions commonly use. Each row is a change or a
documented requirement:

| common SCP | effect on spore.host today | design response |
|---|---|---|
| region deny (only allowed regions) | the CLI pins control-plane calls to `us-east-1` in 13 places; the bootstrap falls back to the `us-east-1` binaries bucket; price lookups call the Pricing API's `us-east-1` endpoint | home region from the descriptor (R3); fallback region = home region (R7); pricing degrades to the labelled static price list when denied (truffle#184), and the denial is reported |
| deny `iam:CreateRole` unless a permissions boundary is attached | **launches fail**: spawn creates `spawn-instance-<hash>` roles at launch time (`pkg/aws/iam.go:726`, `:1596`); also the image builder, bot, onboard, reaper and lagotto role creation | descriptor `iam.permissions_boundary`, `role_path` and `role_prefix` at every `CreateRole` (R9); better, pre-provisioned instance roles from the member baseline, so users create no roles at all (R9) |
| deny IAM changes outside a path (`/spore/`) | same | `role_path` (R9) |
| require IMDSv2 (`ec2:MetadataHttpTokens`) | already compatible: launches set `HttpTokens=required` (`pkg/aws/launch_settings.go:345`). The bootstrap's token-less fallback (`pkg/launcher/bootstrap.go:1102`) assumes `us-east-1` if both metadata reads fail | the fallback becomes the home region (R7) |
| require encrypted EBS / a specific KMS key | the launch must use the account default or a named key; users need `kms:CreateGrant` on it | descriptor `launch.kms_key`; the grant goes in the `spore-user` policy |
| deny public IP / internet gateway attach | the DNS default and SSH SGs assume public reachability | SSM-only connect, private DNS ([§8](#_8-networking)) |
| data perimeter (`aws:ResourceOrgID`, `aws:PrincipalOrgID`) | spored download from spore.host's buckets, public ECR images and the GitHub plugin registry are all denied | institution-hosted binaries, private ECR, internal registry ([§10](#_10-distribution)) |
| deny instance types (GPU families) | launches fail with a bare error | `spawn doctor` simulates `RunInstances` per allowed family (Phase 0 item 3); the CLI names the SCP denial |
| deny `lambda:CreateFunctionUrlConfig` with `AuthType NONE` | already compatible: the updater uses `AWS_IAM` | the trust guard (§6.3) keeps it so |
| deny leaving CloudTrail / Config alone | already compatible | none |

spawn already has launch-time compliance modes (`--nist-800-171`, `--nist-800-53`,
`--compliance-strict`; `pkg/compliance`) that validate encrypted EBS and IMDSv2. The
descriptor can make one of them the deployment's default (`launch.compliance`). They're
refused on sweeps today (`cmd/launch_sweep_flags.go:193`), so that default must not
silently disappear on the sweep path. Sweeps either inherit it (spawn#1391) or refuse.

`spawn doctor --deployment` runs `iam:SimulatePrincipalPolicy` for the caller on the
representative actions, the same list Phase 0 item 3 uses. An SCP denial is then
reported before a launch fails.

### 9.5 Data residency and regions

- **One home region per deployment.** Everything regional in the hub lives there.
  Binaries buckets exist only in allowed regions.
- **No implicit `us-east-1`.** Today it is the fallback region for binaries
  (`pkg/sporedinstall/install.go:147`) and the region for every control-plane call. In
  institutional mode the fallback is the home region, and a launch in an allowed region
  that has no bucket fails before launch (spawn#878).
- **Global services** the deployment uses: IAM, STS (regional endpoints preferred),
  Route53 and CloudFront (if the portal is public). They're listed so the residency
  review can see them.
- **What leaves the account.** In institutional mode, nothing goes to spore.host. The
  deployment packet's "what leaves the account" table gets an institutional column, and
  every row in it must say "nothing". A repository test asserts that institutional mode
  makes no request to a hosted endpoint (R5).

### 9.6 Logging and audit

- **CloudTrail** is the institution's, usually an organization trail. spore.host adds
  nothing to it, but relies on it.
- **Source identity** on every role session ties each `RunInstances`, `TerminateInstances`
  and Lambda action to a person.
- **Lambda Function URL invocations are data events**, which CloudTrail doesn't log by
  default. Today the DNS updater's callers are visible only as `AssumeRole`. The hub
  therefore puts its APIs behind API Gateway with access logs, and enables Lambda data
  events for the updater where the institution wants it.
- **Application audit**: hub Lambdas log a structured line per mutating action (who,
  team, account, resource, result). The bot already has an audit table. Log groups get a
  retention (30 days by default, #770) set by parameter.
- **spored** writes lifecycle events (TTL, idle, cost-limit actions) to tags today. In
  institutional mode it also emits them to CloudWatch Logs in the member account, so
  they survive the instance.

### 9.7 Encryption

DynamoDB and S3 are encrypted at rest by default. A stack parameter selects a customer
managed KMS key per class (tables, buckets, logs). Bot workspace secrets are
KMS-encrypted (spawn#868, spore-host#611, both blocking 1.0). All endpoints are
TLS-only, and bucket policies deny non-TLS access.

---

## 10. Distribution

### 10.1 spored binaries

- **Today**: the bootstrap downloads spored over anonymous HTTPS from
  `spawn-binaries-<region>` (11 regions) and falls back to `us-east-1`. The binary is
  verified against a public key compiled into spawn
  (`pkg/sporedinstall/install.go:41-62`; the private key is in KMS in 966362334030).
- **Institutional**: `spawn binaries sync --to-deployment` copies the release's spored
  artifacts (binaries, `.sha256`, `.sig`, the bootstrap body) into the institution's
  buckets, one per allowed region. It verifies each signature first and records the
  copy in the manifest.
- **Why this is not a mirror in the sense the owner rejects** (spawn#1507, closed): the
  objects are spore.host's own first-party, signed artifacts, byte for byte. The
  signature is checked against the key compiled into spawn, so a tampered copy fails
  verification exactly as it would from spore.host's bucket. The copy exists because
  data-perimeter policies and region-deny SCPs make spore.host's buckets unreachable
  (§8.4), not to own third-party software. Where policy allows, the descriptor can point
  at spore.host's public buckets, and no copy is made (D9).
- **Rebuilding from source** (some institutions require it) produces binaries that
  spore.host's key didn't sign. Supporting that needs `binaries.extra_signing_keys`:
  institution keys that spawn accepts *in addition to* spore.host's, and only from the
  descriptor (D10). Without it, rebuilt binaries can't be verified, and the bootstrap
  must refuse them, not skip the check.
- spawn#20 (a published region manifest) becomes the manifest the sync tool reads.

### 10.2 Plugins

- **Today**: plugin specs come from `raw.githubusercontent.com` and release assets from
  `github.com`, with keyless cosign signatures tied to spore-plugins' release workflow.
  The base URLs are constants (`spawn/pkg/plugin/registry.go:139-141`), with no user
  override.
- **Institutional**: the descriptor names an internal registry base (an internal Git
  host or an HTTPS bucket holding a copy of the spore-plugins release assets, which are
  first-party and signed, as with spored). Signature verification must work without
  reaching Rekor or Fulcio. Whether the cosign bundles spore-plugins publishes verify
  offline against a pinned trusted root is open question Q4.
- A plugin's own downloads (third-party installers inside `plugin.yaml`) go through the
  proxy. spawn#838 (artifact checksums) is a prerequisite for trusting them at all.

### 10.3 Catalog images

The catalog points at public ECR (`public.ecr.aws/f8g1e7l5`, `libs/catalog/catalog.yaml:15`).
Under a data perimeter the institution needs them in its private ECR. An ECR pull-through
cache rule is the low-maintenance way. It is a cache of spore.host's own images, not of
third-party software, so the P7 argument applies again. The catalog overlay (libs#17)
already lets an institution rebind images.

### 10.4 The CLIs themselves

Homebrew, Scoop, `.deb` and `.rpm` from GitHub Releases, signed with cosign plus SLSA
provenance (#344). Institutions that require an internal software catalog redistribute
the signed release artifacts. The docs give the verification command. Nothing in the
CLI phones home.

---

## 11. Phasing

| phase | goal | items (§12) |
|---|---|---|
| 0 | read-only discovery in the institutional environment (#273, under way) | none |
| A | **single-account reference deployment** at `spore.research.wwps.aws.dev`, Midway integ, T1 | R1–R3, R5–R12, R15–R17, R21, R22, R23, R28, R29 |
| B | organization model: StackSet baseline, hub-to-member roles, #377 | R4, R18, R19, R20, R24, R25 |
| C | chargeback, private DNS, bot, plugins, the remaining ports | R13, R14, R26, R27, R30–R34 |
| docs | every tutorial run end to end on the reference deployment (#652) | written alongside A–C |

---

## 12. Refactoring required

Ordered by dependency: an item depends only on items above it. Sizes are S (days),
M (one to two weeks) and L (more). "New" means no issue exists. These are listed for
the owner and **not filed**.

| # | item | size | depends on | issue |
|---|---|---|---|---|
| R1 | **Deployment descriptor**: schema `spore.host/deployment/v1` in libs (Go types plus JSON Schema for the TS ports and portal), the resolution order of §7.2, the fail-closed rule, a `[deployment]` table in sporeconfig | M | none | new (absorbs #274's unmet criteria) |
| R2 | **One configuration path in spawn.** Move `pkg/config/endpoints.go`, `pkg/config/infrastructure.go` and `pkg/infrastructure/resolver.go` onto the descriptor; hosted values become a single "hosted" descriptor compiled in once; deprecate `SPORE_ENV` and the duplicate `infrastructure:` block | M | R1 | #274 (reopen) / spawn#365 |
| R3 | **Control-plane home region** in place of the 13 `LoadInfraAWSConfig(ctx, "us-east-1")`-style pins in `cmd/` | S | R2 | new |
| R4 | **CLI-to-hub access in Model O (D6)**: Lambda and DynamoDB resource policies with `aws:PrincipalOrgID` and `LeadingKeys` scoping as the bridge; IAM-auth API routes as the end state, retiring the CLI's direct infra-table reads | L | R2, R20 | new |
| R5 | **Trust guard and hosted-endpoint guard** (§6.3, §9.5): one package used by every trust-creating path; a repository test that institutional mode emits no request to a spore.host endpoint and no trust outside the organization; 942542972736 refused unconditionally | S | R1 | new |
| R6 | **DNS domain parameterized wherever a name is composed**: `pkg/provider/ec2.go:385`, `pkg/agent/notifier.go:79`, `pkg/mpicohort/assembler.go:44`, `pkg/dns/client.go:25`, `lambda/pipeline-orchestrator/main.go:1050`, `lambda/dashboard-api/utils.go:69`, `lambda/dns-updater/main.go:124-129`, umbrella `lambda/spore-bot/executor.go:216,240`; `--name` stops implying DNS in institutional mode | M | R1 | new (custom DNS #891 covered the launch path only) |
| R7 | **Binaries location parameterized**: bootstrap URLs (`pkg/launcher/bootstrap.go:919,1121-1122`, `cmd/app.go:775-776,938-939`, `cmd/upgrade_spored.go:310`, `lambda/pipeline-orchestrator/main.go:1308-1309`, `pkg/sporedinstall/windows.go:98-205`, `internal/s3hosts`), IAM grants (`pkg/aws/iam.go:173-196,1932`, `cmd/pool.go:102`), fallback region = home region | M | R1, R3 | spawn#878 (bucket-less regions), spawn#19 |
| R8 | **`spawn binaries sync`** with signature verification, per allowed region, recorded in the manifest; the published region manifest | M | R7 | spawn#20 |
| R9 | **IAM under institutional guardrails**: permissions boundary, path and prefix at every `CreateRole` (spawn `pkg/aws/iam.go:726,1596`, `pkg/aws/imagebuilder.go:125`, `pkg/bot/crossaccount.go:260`, `cmd/onboard.go:315`, `pkg/reaperdeploy/deployer.go:473`; lagotto `pkg/runtimeiam/runtimeiam.go:179,223`); a *pre-provisioned roles* mode where the baseline supplies instance roles and launches create none | M | R1 | spore-host#610 |
| R10 | **Required tags on every created resource**, tag-budget accounting with a refusal that names the tags | M | R1 | new; spawn#1245 |
| R11 | **Secure network defaults**: no `0.0.0.0/0` ingress in institutional mode (`pkg/aws/securitygroup.go`), SSM-only connect, `inbound_cidrs` | M | R1 | new |
| R12 | **Subnets and security groups from the descriptor** on every launch path, including lagotto spawn/hold | M | R1 | spawn#1476, lagotto#256 (follow-up) |
| R13 | **DNS registration through `lambda:InvokeFunction`** (works over a VPC endpoint), an `aws:PrincipalOrgID` resource policy, and the private hosted zone option | M | R6 | new |
| R14 | **Institution-provided egress proxy** in the descriptor, as an alternative to the managed proxy (D11) | S | R1 | new |
| R15 | **The CloudFormation bundle**: `hub.yaml` and `member-baseline.yaml` generated and tested (cfn-lint, cfn-guard, a full-parameter-file gate, a real `PutRolePolicy` per policy), no SAM transform, fixed names, descriptor written to SSM | L | R1, R5, R9 | #276 (rescoped) |
| R16 | **Versioned umbrella artifacts**: rest-api, spore-bot and portal builds published per version (the umbrella is rolling and untagged today) | M | none | new |
| R17 | **Bundle manifest and signing, plus `spawn infra plan/apply/status/upgrade/teardown`**: change-set based, snapshot and diff before and after, API-level skew check | L | R15, R16 | new; spawn#1302 |
| R18 | **One implementation for components installable both ways** (reaper, lagotto poller, egress proxy): render the CloudFormation from the Go spec or gate parity with a test; the ownership tag stops duplicate installs | M | R15 | spawn#780 / #769 |
| R19 | **Member baseline**: in-account reaper, `SpawnSweepCrossAccountRole` (replacing the manual script), instance roles, the `spore-user` policy, the SSM descriptor, DNS invoke grants | M | R15, R18 | spawn#1537 |
| R20 | **Hub mode for cross-account functions**: sweep-orchestrator, dashboard-api (role ARN from the descriptor, `cross_account.go:54`), rest-api AssumeRole (#377), bot, cost reader; every trust through R5 | L | R5, R19 | #377, spawn#780 |
| R21 | **Teardown completeness**: a deleter for every row of §4.6, the bucket purge flow, `--retain-data`, and a footprint-zero test | M | R17 | spawn#1302, spore-host#610 |
| R22 | **Portal runtime configuration**: load the descriptor at runtime (`.well-known`) in place of Vite build-time variables (`web/.env.production`, `web/app/config.ts`), so one prebuilt portal serves every deployment | S | R1 | new |
| R23 | **Portal federation broker**: Cognito identity pool with an OIDC or SAML provider set by stack parameter (Midway integ/prod switchable), claim-to-role and claim-to-tag rules; Globus becomes one provider among several | L | R22 | #275 |
| R24 | **Team from principal tags, user from source identity**: teams store keyed on source identity; the ABAC conditions in `spore-user`; the group-to-team map | M | R23 | spore-host#531 + new |
| R25 | **SigV4 everywhere**: the dashboard-api behind API Gateway IAM auth (retiring `X-AWS-Credentials`); API keys bound to a principal; the legacy dashboard left out of the bundle | L | R23 | spore-host#588 + new |
| R26 | **`spawn cost report`**: estimate and billed (Data Exports / Cost Explorer) by team, project, account and user; JSON and CSV; labelled | L | R10, R24 | #277 |
| R27 | **Scheduled chargeback export** and a cost-history-collector that works per deployment (account set from the descriptor) | M | R26 | #277 |
| R28 | **`spawn doctor --deployment`**: descriptor present and readable, endpoints reachable, versions in the window, reaper coverage, SCP simulation of representative actions, cost-allocation tags active | M | R1, R17 | new |
| R29 | **Fix the docs that would mislead an installer now**: `infra/DEPLOY.md:215-227` (Function URL `NONE` / `Principal *`), `self-hosting.md:262` (#636), the root `DEPLOYMENT_GUIDE.md` (an older three-model guide); remove legacy umbrella scripts that hardcode 942542972736 or 752123829273 (`scripts/setup-dashboard-lambda-role.sh:11`, `scripts/setup-dashboard-dynamodb.sh:7`) | S | none | #636 + new |
| R30 | **Python SDK discovery**: `DEFAULT_API_URL` (`python-sdk/spore/client.py:25`, and the umbrella copy `sdk/python/spore/client.py:25`) resolved from the descriptor; the SigV4 docstring (python-sdk#13) | S | R1, R25 | python-sdk#13 + new |
| R31 | **TS ports follow R1, R6 and R7**: spawn-ts `src/aws/userdata.ts:215` (which also uses the global S3 endpoint form that Go dropped in #1436), DNS naming in `src/dns/*` and `src/core/tags.ts`; carried by the parity vectors | M | R1, R6, R7 | spawn-ts#120 |
| R32 | **#579's gate for the bot template**, applied to the bundle's bot component | S | R15 | #579 |
| R33 | **Pricing under region-deny SCPs**: a denied Pricing API is reported as such and falls to the labelled static list | S | none | new (truffle#184 did the labelling) |
| R34 | **Wildcard TLS for the institution's domain**: automated issuance and renewal in the hub, with a private-CA option | M | R6 | spore-host#295 |

Totals: **34 items: 8 S, 19 M, 7 L.**

---

## 13. Readiness checklist (Phase 0)

The nine categories match the Phase 0 brief on #273. For each: what the report must
establish, which decisions it feeds, and the default if the answer is the common case.

| # | category | establish | feeds | default if common |
|---|---|---|---|---|
| 1 | **Identity and org** | caller and account; organization ID and OU path; SCPs; permissions-boundary requirement; role path and naming conventions; how people get credentials (Identity Center, SAML or OIDC; which IdP); whether `aws login` works; group claim names and shape; whether the account is itself an organization management account | D1, D4, D5, D6, D7, R9, R23, R24; the trust guard's inputs | Identity Center + SAML IdP; boundary required → R9 with a boundary parameter; portal via broker B |
| 2 | **Regions** | allowed regions; data-residency rules; primary region | home region; binaries regions (R7, R8); D16 | one home region plus one other; no `us-east-1` assumption |
| 3 | **Service availability under SCPs** | allowed or denied per action: Lambda, DynamoDB, API Gateway v2, EventBridge Scheduler, SNS, SES, Cognito, KMS, S3, CloudFront, Route53, SSM, EC2 (`RunInstances`, `CreateCapacityReservation`), IAM (`CreateRole`, `PutRolePolicy`, `PassRole`), Service Quotas, Pricing; the denying SCP where identifiable | D4 (Cognito allowed?), D2, D12, R33; features to disable | all allowed except Pricing and CloudFront; components whose service is denied are switched off in the descriptor |
| 4 | **Networking** | VPCs; default VPC per region; public and private subnets per AZ; NAT; VPC endpoints; required egress proxy; whether instances may have public IPs | R11–R14, D11; `launch.*` in the descriptor | no default VPC, private subnets, central endpoints, existing proxy → descriptor subnets, `connect: ssm`, institution proxy |
| 5 | **DNS** | visible hosted zones; whether a subdomain can be delegated, and who owns the parent; public versus private naming policy; certificate policy (public ACM or private CA) | D12, R13, R34; the portal and API domains | delegated public subdomain for portal and API; private zone for instance names |
| 6 | **Guardrails** | Config rules and auto-remediation (public S3, unencrypted volumes, open SGs, required tags); S3 Block Public Access; tag policies and mandatory tags; CloudTrail (organization trail?); GuardDuty and Security Hub; budget alerts | R10, R11, §9.3, §9.6 | BPA on (the portal goes behind CloudFront with OAC), open-SG remediation on (→ R11), mandatory CostCenter/Owner tags (→ R10) |
| 7 | **Quotas** | On-Demand and Spot vCPU quotas per family (Standard, G, P, Trn/Inf, …) in the allowed regions | D7 (shared versus per-team accounts); the reference smoke tests | Standard only; GPU quota requests are part of onboarding |
| 8 | **Cost conventions** | required cost-allocation tags; the chargeback system and its import format; who owns budgets; whether cost-allocation tags can be activated (management account) | D13, R26, R27 | CUR/Data Exports exists; finance wants a monthly CSV by cost center |
| 9 | **Change control** | approval processes, change windows, security-review lead times (IdP app registration; for Midway prod, the review) | D14 (compatibility window), D2 (artifact reviewability), the schedule | quarterly windows → the N-1 window; a CloudFormation change set as the reviewable artifact |

The installer tutorial's prerequisites page is generated from this table (#652).

---

## 14. Documentation plan

Documentation and tutorials are required deliverables (owner, 2026-11-08;
[#652](https://github.com/spore-host/spore-host/issues/652)). The doc set by audience,
each tutorial's outline, and the decisions it waits on:

| audience | document | outline | depends on |
|---|---|---|---|
| **installer (cloud team)** | Architecture overview | what runs where (hub, member, single), data flows, trust boundaries, diagrams per model | D1, D6, D8 |
| | Readiness checklist | §13, as a fillable page | Phase 0 |
| | **Tutorial: single-account install** | prerequisites → DNS delegation → IdP registration → `spawn infra plan` → review → apply → `spawn binaries sync` → `spawn doctor --deployment` → assign `spore-user` → smoke test (launch, DNS, reaper dry run, arm, TTL) | D1–D4, D9, D12, R15–R17 |
| | **Tutorial: organization install** | the single-account steps, then the StackSet for the member baseline per OU, hub roles, verifying one member account, adding a new account | D6, D7, D8, R19, R20 |
| | Parameter reference | every stack parameter and descriptor field: type, default, effect, which Phase 0 answer sets it (generated from `parameters.schema.json`) | R1, R15 |
| | Upgrades and version skew | the compatibility window, `spawn infra status`, the upgrade change set, rollback, what spored does | D14, R17 |
| | Teardown | §4.6 as a runnable procedure, retained data, removing the IdP registration and the parent delegation | R21 |
| | SCP, Config and tag-policy compatibility | §9.4 and §9.3 as a checklist with the exemption text to request | R9–R11 |
| | Private networking | endpoints, the egress proxy (or the institution's), private DNS | D11, D12, R13, R14 |
| | Hosting binaries and plugins internally | `spawn binaries sync`, the plugin registry copy, private ECR, verification | D9, D10, R8 |
| **identity admin** | Tutorial: Midway (reference) | register the app (integ), group claims, broker provider, test sign-in, the group-to-team map, then prod after review | D4, D5, R23 |
| | Tutorial: Okta | OIDC app (or SAML), groups claim or tags claim, broker or direct (A), CLI through Identity Center | D4, D5 |
| | Tutorial: Microsoft Entra ID | app registration, app roles in place of groups (overage), broker, CLI | D4, D5 |
| | Tutorial: Shibboleth / InCommon | SAML SP metadata from the broker, `eduPersonEntitlement` or `isMemberOf` mapping, CILogon/Globus alternative | D4, D5 |
| | Group-to-team mapping reference | principal tags, source identity, ABAC conditions, the teams-table fallback | D5, R24 |
| **security reviewer** | IAM inventory | every role and policy in the bundle and created at runtime, each grant with its reason (generated from the templates and the IAM coverage test) | R9, R15, R20 |
| | Trust boundaries and the trust guard | §6.3, what can trust what, the tests that prove it | R5 |
| | Data handling, residency, encryption | §9.5, §9.7; "what leaves the account: nothing" | R5 |
| | Logging and audit | §9.6: CloudTrail, source identity, data events, application audit | R24, R25 |
| | Threat model summary | assets, actors, boundaries, mitigations; the deployment-packet page extended for institutional mode | all of the above |
| **finance** | Chargeback and cost reporting | estimate versus billed, `spawn cost report`, scheduled export, activating cost-allocation tags, budgets | D13, R26, R27 |
| **operators** | Runbook | `spawn doctor --deployment`, alarms, reaper status and arming, common failures (SCP denials, missing descriptor, skew, DNS), recovery, support escalation | R17, R28 |
| **end users** | **Tutorial: getting started at your institution** | sign in (`aws login` or the portal) → `spawn doctor` shows the institution's deployment → first launch → `spawn connect` (SSM) → first lagotto watch → cost view; how it differs from hosted spore.host (no spore.host DNS, institution limits, tags applied for you) | D4, D12, R1 |

Existing pages that change: [Self-hosting](../guides/self-hosting.md) is replaced by the
installer set (and fixed now, #636). The [deployment packet](../reference/deployment-packet.md)
gains an institutional column. `infra/DEPLOY.md` and the root `DEPLOYMENT_GUIDE.md` are
retired (R29). "Done" is #652's bar: every tutorial run end to end on 812107987990 by
following only the docs, with the umbrella docs CI passing.

---

## 15. Risks

| risk | why it matters | mitigation |
|---|---|---|
| **An external trust lands in an Amazon-internal account** | the reference account 812107987990 is Amazon-internal; the 2026-09-26 incident showed the detector denies a trust in 12 minutes and files a ticket. A GitHub OIDC deploy role or a Globus OIDC provider there would be the same class of finding | P1 (pull, never push); Midway as the only IdP for the reference; the trust guard (R5); Phase 0 records the organization position of 812107987990 before any trust is created |
| **A silent hosted fallback sends institutional data to spore.host** | today a named launch registers with spore.host's DNS updater by default; any missed default does the same in institutional mode | fail-closed descriptor (R1, R2); the no-hosted-request test (R5); the "nothing leaves" table checked in review |
| **Size** | 34 items, 8 of them L, during a hardening phase that otherwise forbids features | phasing (§11): Phase A is 19 items, most S/M; Model O and chargeback can follow |
| **Version skew becomes an outage** | institutions upgrade quarterly; the Homebrew CLI moves weekly | API levels, the N-1 window, the CLI refusing a feature cleanly (D14) |
| **Two installers fight over one component** | `spawn reaper deploy` and the stack both create the reaper | the ownership tag and refusal (R18) |
| **CloudFormation traps recur** | the project has a record of parameter resets and SAM surprises | the gates in §4.2; full parameter files; change-set review; snapshot and diff |
| **Launch-time IAM creation is denied by SCP** | the most common institutional SCP breaks every launch today | R9, early in Phase A |
| **Tag budget exhaustion** | institutional mandatory tags plus spawn's tags exceed 50 | R10's accounting; dropping unread tags (spawn#1245) |
| **`aws login` may not work with the institution's federation** | it is the documented sign-in | Phase 0 item 1; the CLIs accept any credential source, so only the docs change |
| **Midway prod review lead time** | blocks the live reference deployment | register on integ now; start the prod review in parallel with Phase A |
| **Cost estimates disagree with the bill** | finance stops trusting the tool | both columns, labelled, with billed as the source of truth (D13) |
| **Test matrix doubles** | hosted and institutional modes, single and organization | institutional-mode e2e on a scratch account per release; substrate where it models the calls (it doesn't model `ec2:GetConsoleOutput`, for one) |
| **Docs mislead before the code exists** | `infra/DEPLOY.md` currently instructs a public, unauthenticated DNS updater | R29 now, independent of the rest |

---

## 16. Decisions for the owner

| # | decision | recommendation |
|---|---|---|
| D1 | First deployment model | **single account** (Model S), then the organization model |
| D2 | Installation artifact | **CloudFormation** + `spawn infra` wrapper + StackSets + a Terraform wrapper; direct-SDK installers kept for hosted users |
| D3 | Naming | **fixed account-scoped names**, parameterized buckets, domains and ARNs; one deployment per account |
| D4 | Portal sign-in | **Cognito identity pool broker** (OIDC and SAML); IAM OIDC direct allowed; Lambda JWT validation not recommended |
| D5 | Team source of truth | **IdP group → principal tag**, user = source identity; teams tables as fallback |
| D6 | CLI access to the hub in Model O | resource policies (bridge), then **IAM-auth API** (end state) |
| D7 | Default tenancy | T1 (shared account + ABAC) for companies and the reference; T2 (account per team) for universities |
| D8 | Reaper placement in Model O | **in each member account**, no cross-account trust; hub mode optional |
| D9 | spored binaries | **institution-hosted copy** of signed artifacts when policy requires; spore.host's buckets when it allows |
| D10 | Rebuilt binaries | allow institution signing keys **in addition to** spore.host's, from the descriptor only? |
| D11 | Egress | allow the **institution's own proxy** beside the managed one |
| D12 | Instance DNS | **off unless configured**; private hosted zone supported; public zone opt-in |
| D13 | Chargeback truth | **billed (CUR / Data Exports)**; estimates for guardrails |
| D14 | Compatibility window | CLI supports control-plane API **N and N-1** |
| D15 | lagotto in the member baseline | keep `lagotto deploy`/`setup` as is, or fold the poller into the baseline? |
| D16 | Air-gapped | **out of scope before 1.0** beyond "no internet, with endpoints and a golden AMI" |
| D17 | Legacy dashboard (`web/dashboard.html`, `web/js/*`) | leave it out of the bundle; retire it for hosted spore.host? |
| D18 | The reference deployment's shape | is 812107987990 a single-account deployment, or the hub of an organization layout? Depends on Phase 0 item 1 |

### Open questions

- **Q1.** Does `aws login` work for the reference environment's federation path (Midway
  into an Isengard console role)? (Phase 0 item 1)
- **Q2.** Is 812107987990 a member of an Amazon-internal organization, and which SCPs
  apply? That decides whether any cross-account layout is possible there at all.
- **Q3.** Do Midway integ tokens carry group claims usable by an identity-pool rule, and
  under what claim name?
- **Q4.** Do spore-plugins' cosign bundles verify offline against a pinned trusted root,
  or do they need Rekor at install time?
- **Q5.** Does a Lambda Function URL with `AuthType: AWS_IAM` honour an
  `aws:PrincipalOrgID` condition in its resource policy, as the updater design assumes?
  A live test settles it.
- **Q6.** Should the hosted spore.host deployment itself move onto the bundle (dogfooding,
  spawn#780's argument), or stay on its OpenTofu modules?
- **Q7.** What does the `spawn-ts-portal` Lambda in 966362334030 do, and does an
  institution need it?
- **Q8.** Should #274 be reopened (its criteria are unmet), or closed in favour of R1/R2?

---

## Appendix A. Hardcoded-value inventory

Scanned 2026-11-08 at the commits listed at the top. Test files, Markdown and
`node_modules` are excluded unless stated. "Functional" means the value changes
behaviour; comments, help text and branding are left out. Fixed table names are listed
for completeness but are acceptable under D3.

### A.1 spore.host account IDs

**spawn, Go:**

| file:line | value | purpose |
|---|---|---|
| `pkg/config/endpoints.go:153` | `arn:aws:lambda:*:966362334030:function:spawn-dns-updater` | instance-role grant for the hosted DNS updater |
| `pkg/config/endpoints.go:189` | `arn:aws:iam::966362334030:role/spore-bot-role` | trust principal of `SpawnBotCrossAccount` roles |
| `pkg/config/endpoints.go:213-214` | `arn:aws:iam::966362334030:role/PortalPhoneHomeLambdaRole` | trust principal of the `spawn onboard` role |
| `pkg/infrastructure/resolver.go:11`, `:156` | `966362334030` | shared-mode infra account; Lambda ARNs built from it |
| `lambda/dashboard-api/cross_account.go:54` | `arn:aws:iam::435415984226:role/SpawnDashboardCrossAccountReadRole` | the member read role the dashboard assumes |
| `lambda/scheduler-handler/main.go:46` | `966362334030` (default of `SPAWN_INFRA_ACCOUNT_ID`) | ARNs built by the scheduler |
| `scripts/deploylambdas/main.go:60` | `966362334030` | operated-functions account (operator tool) |

**spawn, scripts, templates and workflows** (operator tooling; must not ship in the
bundle as-is):

| file:line | value |
|---|---|
| `scripts/deploy-custom-dns.sh:109`, `scripts/setup-schedules-dynamodb.sh:56`, `scripts/deploy-sweep-orchestrator.sh:25`, `scripts/setup-lambda-deploy-ci-role.sh:41`, `scripts/setup-sweep-orchestrator-lambda-role.sh:13`, `scripts/deploy-cost-history-collector.sh:46`, `scripts/deploy-scheduler-handler.sh:31`, `lambda/dashboard-api/scripts/setup-dashboard-lambda-role.sh:16`, `lambda/dashboard-api/scripts/setup-user-accounts-table.sh:16`, `lambda/dashboard-api/scripts/deploy.sh:12`, `lambda/dashboard-api/deploy.sh:22`, `lambda/dashboard-websocket/deploy.sh:23`, `lambda/dashboard-websocket-processor/deploy.sh:25` | `EXPECTED_ACCOUNT` defaults to `966362334030` (`SPAWN_LAMBDA_ACCOUNT` overrides) |
| `scripts/setup-sweep-cross-account-role.sh:5`, `:20`; `lambda/dashboard-api/scripts/setup-cross-account-role.sh:6`, `:20`; `scripts/setup-spawnd-iam-role.sh:19`, `:81` | `966362334030` as the trusted infra account or the DNS function |
| `scripts/hardware-test-detached-sweep.sh:42`; `lambda/dashboard-api/scripts/create-user-mapping.sh:9-10` | `435415984226` |
| `lambda/ttl-reaper/Makefile:62`, `:250`; `lambda/ttl-reaper/template.yaml:18` | reaper role in `435415984226`; reaper account `966362334030` |
| `deployment/cloudformation/ttl-reaper-instance-events.yaml:21`, `ttl-reaper-cross-account-role.yaml:20`, `bot-cross-account-role.yaml:15` | template defaults naming `966362334030` |
| `.github/workflows/deploy-lambdas.yaml:135`, `.github/workflows/release.yaml:87`, `:348` | CI roles in `966362334030` (operator-only, by P1) |

**spore-host (umbrella):**

| file:line | value |
|---|---|
| `web/.env.production:19` | `arn:aws:iam::435415984226:role/spore-portal-launch` (portal launch role) |
| `web/.env.production:28` | `arn:aws:iam::966362334030:role/PortalPhoneHomeLambdaRole` |
| `web/js/main.js:296` | `arn:aws:iam::435415984226:role/SpawnDashboardCrossAccountReadRole` (legacy dashboard) |
| `infra/tofu/{docs-site,portal-oidc,portal-account-prober,spore-bot,portal-phone-home,dns-updater}/main.tf` (backend `bucket` lines 26–44; `account_id` at `docs-site:67`, `spore-bot:62`, `dns-updater:94`; ACM ARN `docs-site:71`) | state bucket `spore-host-tofu-state-966362334030`, account pins (operator-only) |
| `infra/tofu/state-bucket.sh:15` | `966362334030` |
| `lambda/spore-bot/Makefile:41` | `EXPECTED_ACCOUNT ?= 966362334030` |
| `scripts/setup-dashboard-cross-account-role.sh:11`, `scripts/create-user-mapping.sh:18-21`, `scripts/setup-github-oauth-lambda.sh:105` | `966362334030` / `435415984226` (legacy scripts) |
| **`scripts/setup-dashboard-lambda-role.sh:11`** | **`942542972736`** ("Account with EC2 instances"); the script must be deleted (R29) |
| `scripts/setup-dashboard-dynamodb.sh:7`, `scripts/setup-dashboard-lambda-role.sh:7`, `:40` | `752123829273` (legacy) |
| `.github/workflows/docs.yaml:44`, `.github/workflows/deploy-site.yaml:97` | docs/site deploy role (operator-only) |

**spore-plugins:** `.github/workflows/integration.yml:15`, a comment naming
`435415984226` (operator-only).

### A.2 Lambda Function URLs and API endpoints

| file:line | value | purpose |
|---|---|---|
| spawn `pkg/config/endpoints.go:136-137` | `https://awdzf7fbbsvqcrnrzusqjsuybm0iiyvf.lambda-url.us-east-1.on.aws` | notify (spore-bot) |
| spawn `pkg/config/endpoints.go:142-143` | `https://zqonqra6blwh7342ujuxv3bwei0wnpyq.lambda-url.us-east-1.on.aws/` | DNS updater |
| spawn `pkg/config/endpoints.go:229-230` | `https://omnvm7osdhhnr2f7qm4xghz2xq0txwjl.lambda-url.us-east-1.on.aws/` | portal phone-home |
| umbrella `web/.env.production:29`; `deployment/cloudformation/portal-onboarding-role.yaml:44` | phone-home URL | BYOA onboarding |
| umbrella `sdk/python/spore/client.py:25`; python-sdk `spore/client.py:25` | `https://v7ochiyks4uknie3u4s7tiix7a0ejduj.lambda-url.us-east-1.on.aws` | REST API default |
| umbrella `web/.env.production:25`; `web/app/config.ts:12` | `https://api.spore.host` | dashboard-api base (new portal) |
| umbrella `web/js/main.js` (15 occurrences, e.g. `:1294`, `:1559`, `:2541`, `:2898`), `web/js/websocket.js:41`, `web/dashboard.html` (1) | `https://api.spore.host/...` | legacy dashboard |
| umbrella `web/js/websocket.js:55` | `wss://ir832sgfz2.execute-api.us-east-1.amazonaws.com/production` | WebSocket API |
| umbrella `web/js/auth.js:33` | `https://1yr1kjdm5j.execute-api.us-east-1.amazonaws.com/github/callback` | GitHub OAuth bridge |
| spawn `lambda/dashboard-api/slack_oauth.go:435`, `:443` | `api.spore.host`, `https://spore.host/dashboard.html` | Slack OAuth redirect |
| spawn `lambda/dashboard-api/utils.go:12` | CORS origin `https://spore.host` | dashboard-api |
| umbrella `lambda/spore-bot/oauth.go:326` | `https://spore.host/dashboard` | OAuth landing |

### A.3 Identity identifiers (portal)

| file:line | value |
|---|---|
| umbrella `web/.env.production:16` | Globus client ID |
| umbrella `web/js/auth.js:7` | Cognito identity pool `us-east-1:f51165b6-…` |
| umbrella `web/js/auth.js:12`, `:20`, `:28` | Globus, Google and GitHub client IDs (legacy dashboard) |

### A.4 AWS profile names

| file:line | value | functional? |
|---|---|---|
| spawn `pkg/config/endpoints.go:50` | `spore-host-infra` (default of `SPAWN_INFRA_PROFILE`) | **yes**: every infra call in `cmd/` uses it unless overridden |
| spawn `pkg/testutil/integration_helpers.go:65`, `test/e2e/helpers.go:97` | `spore-host-dev` | tests only |
| spawn `scripts/setup-availability-dynamodb.sh:5`, `scripts/deploy-scheduler-handler.sh:24`, `scripts/deploy-cost-history-collector.sh:40`, `scripts/hardware-test-detached-sweep.sh:43`, `lambda/dashboard-api/scripts/{deploy,delete-sweeps,cleanup-stuck-sweeps,create-user-mapping,add-user-accounts-gsi,setup-cross-account-role}.sh` (lines 4–8) | `spore-host-infra` / `spore-host-dev` script defaults | operator scripts |
| umbrella `web/deploy.sh:10`, `lambda/spore-bot/Makefile:38`, `lambda/portal-account-prober/Makefile:26`, `lambda/portal-phone-home/Makefile:26`, `scripts/{setup_s3_buckets,upload_spawnd,setup-dashboard-api-gateway,setup_data_staging_buckets,setup_data_staging_table,setup-mpi-s3-lifecycle,setup-dashboard-dynamodb,setup-dashboard-lambda-role,setup-dashboard-cognito,setup-spawnd-iam-role,setup-teams-tables,create-user-mapping,validate-permissions,deploy-issue-137,setup-dashboard-cross-account-role}.sh`, `infra/tofu/portal-oidc/main.tf:68` | `spore-host-infra` / `spore-host-dev` | operator scripts |

### A.5 Binaries buckets

| file:line | use |
|---|---|
| spawn `pkg/launcher/bootstrap.go:919`, `:1121-1122` | bootstrap download URLs and the `us-east-1` fallback |
| spawn `cmd/app.go:775-776`, `:938-939` | app launch bootstrap |
| spawn `cmd/upgrade_spored.go:310` | in-place upgrade |
| spawn `lambda/pipeline-orchestrator/main.go:1308-1309` | pipeline-stage bootstrap |
| spawn `pkg/sporedinstall/windows.go:98`, `:103`, `:108`, `:205` | Windows install |
| spawn `pkg/sporedinstall/install.go:138`, `:147` | published-region list; `FallbackRegion = "us-east-1"` |
| spawn `internal/s3hosts/s3hosts.go:38`, `:71`, `:129` | `FallbackBucket`, host checks |
| spawn `pkg/aws/iam.go:173-174`, `:196`, `:1932-1933`; `cmd/pool.go:102` | IAM grants on `spawn-binaries-*` |
| spawn `pkg/config/infrastructure.go:77`, `pkg/infrastructure/resolver.go:72` | prefix default |
| spawn `scripts/deploylambdas/main.go:64` | published bootstrap body URL (operator tool) |
| spawn `.github/workflows/release.yaml:20-30` | the 11 published regions |
| spawn-ts `src/aws/userdata.ts:215` | bootstrap download (global S3 endpoint form) |
| truffle `pkg/spawn/regions.go:5-` | supported-regions copy (spawn#20) |
| umbrella `lambda/spore-bot/Makefile:30`, `lambda/portal-account-prober/Makefile:4`, `lambda/portal-phone-home/Makefile:4` | Lambda artifact staging in `spawn-binaries-us-east-1` |
| umbrella `scripts/setup_s3_buckets.sh:74`, `scripts/upload_spawnd.sh:89`, `scripts/setup-mpi-s3-lifecycle.sh:27` | legacy bucket scripts |

### A.6 Domain composed into names

| file:line | composition |
|---|---|
| spawn `pkg/provider/ec2.go:385` | `name.<b36>.spore.host` |
| spawn `pkg/agent/notifier.go:79` | FQDN in notifications |
| spawn `pkg/mpicohort/assembler.go:44` | MPI host names |
| spawn `pkg/dns/client.go:25` | `defaultDomain = "spore.host"` |
| spawn `lambda/pipeline-orchestrator/main.go:1050` | stage DNS names |
| spawn `lambda/dashboard-api/utils.go:69` | dashboard DNS names |
| spawn `lambda/dns-updater/main.go:124`, `:129` | default zone and domain |
| spawn `cmd/app.go:792`, `:959` | wildcard certificate `*.<b36>.spore.host` |
| umbrella `lambda/spore-bot/executor.go:216`, `:240` | instance matching and DNS names in the bot |
| spawn-ts `src/dns/dns-name.ts`, `src/dns/dns-resolve.ts`, `src/core/tags.ts:38`, `:203` | DNS naming port |
| libs `i18n/active.*.toml` (e.g. `active.en.toml:189`, `:623`) | help text showing the format (display only) |

### A.7 Control-plane region pinned to `us-east-1`

spawn `cmd/cancel.go:52`, `cmd/collect.go:117`, `cmd/status.go:697`,
`cmd/availability.go:55`, `cmd/schedule.go:357`, `:414`, `:499`, `:545`,
`cmd/resume.go:536`, `cmd/list-sweeps.go:81`, `cmd/launch_sweep.go:1403`, `:1505`,
`:1657`. Also defaults that are user-facing rather than control-plane:
`cmd/schedule.go:166`, `cmd/onboard.go:103`, `cmd/app.go:311`, `cmd/pipeline.go:360`,
`cmd/queue.go:338`, `pkg/pipeline/pipeline.go:71`, `pkg/wizard/wizard.go:150`.

### A.8 Fixed names (acceptable under D3; listed so a deployment can audit them)

- spawn tables: `spawn-sweep-orchestration` (`lambda/sweep-orchestrator/main.go:34`,
  `lambda/scheduler-handler/main.go:42`, `lambda/dashboard-api/sweeps.go:20`,
  `pkg/sweep/detached.go:27`, `pkg/cost/cost.go:20`), `spawn-pipeline-orchestration`
  (`lambda/pipeline-orchestrator/main.go:39`, `pkg/pipeline/store.go:19`),
  `spawn-schedules` (`pkg/scheduler/types.go:170`), `spawn-schedule-history`
  (`lambda/scheduler-handler/main.go:28`, `pkg/scheduler/scheduler.go:438`, `:451`),
  `spawn-user-accounts` (`lambda/dashboard-api/dynamodb.go:16`, `auth.go:351`, `:407`,
  `lambda/dns-updater/authorize.go:60`, `lambda/cost-history-collector/main.go:20`),
  `spawn-cost-history` (`lambda/dashboard-api/cost_history.go:16`,
  `lambda/cost-history-collector/main.go:21`), `spawn-teams`, `spawn-team-memberships`
  (`lambda/dashboard-api/teams.go:25-26`, `pkg/team/team.go:23-24`), `spawn-ws-tickets`
  (`lambda/dashboard-api/wstoken.go:18`, `lambda/dashboard-websocket/main.go:147`),
  `spawn-websocket-connections` (`lambda/dashboard-websocket/main.go:19`,
  `lambda/dashboard-websocket-processor/main.go:22`), `spawn-hybrid-registry`
  (`pkg/provider/hybrid_registry.go:18`, `pkg/registry/dynamodb.go:19`),
  `spawn-availability-stats` (`pkg/availability/stats.go:16`), `lagotto-watches`,
  `lagotto-match-history` (`lambda/dashboard-api/watches.go:15-16`),
  `spore-bot-workspaces` (`lambda/dashboard-api/slack_oauth.go:108`, `:156`).
- Bucket prefixes that already include the account: `spawn-results-`, `spawn-staging-`
  (`pkg/taskproto/resultsprefix.go:66`), `spawn-reaper-artifacts-<account>-<region>`
  (`pkg/reaperdeploy/reaperdeploy.go:82`). `spawn-schedules-` (`pkg/schedulesweep/schedulesweep.go:77`)
  does **not** include the account, so it collides globally (R7 covers it).
- umbrella tables: `spore-bot-audit` (`lambda/spore-bot/audit.go:48`),
  `spore-bot-registry`, `spore-bot-workspaces` (`lambda/spore-bot/registry.go:172-173`,
  `lambda/rest-api/sms.go:201`), `spore-sms-pending` (`lambda/spore-bot/sms_notify.go:27`,
  `lambda/rest-api/sms.go:27`), `spore-api-keys` (`lambda/rest-api/auth.go:47`),
  `spore-portal-accounts` (`lambda/accountlifecycle/registry.go:74`).
- lagotto tables: `lagotto-watches`, `lagotto-match-history`,
  `lagotto-scheduled-launches` (`lambda/capacity-poller/main.go:53-55`), all in the
  user's own account already.

### A.9 Operator-only values (never shipped)

The CloudFront distribution `EY67INS5HDFLU` (`web/deploy.sh:107`,
`.github/workflows/deploy-site.yaml:138`), the docs bucket `spore-host-docs`
(`.github/workflows/docs.yaml`), the spored signing key's KMS ARN (comment,
`spawn/pkg/sporedinstall/install.go:44`), and the GitHub Actions deploy roles. These
stay with spore.host's own deployment.
