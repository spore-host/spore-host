# Security Overview for spore.host

**Audience:** CISOs, cloud administrators, security engineers.

This page describes what the spore.host tools can do in your AWS account, as
the code stands today. Each section ends with **Where to check**: the repo and
path that does what the section describes. The releases named here are the
first ones that behave this way. Every spore.host component is pre-1.0 (0.x).

> **Reporting a vulnerability:** use GitHub private vulnerability reporting.
> See [Reporting a vulnerability](#reporting-a-vulnerability). Please don't
> open a public issue.

---

## Summary

spore.host is a set of command-line tools, plus one in-instance agent, for
finding EC2 capacity and running ephemeral instances that end themselves. The
tools act in **your** AWS account with **your** credentials. spore.host holds
no credentials of yours and runs none of your compute.

| Component | What it does | Can it change your account? |
|---|---|---|
| **truffle** | Instance-type, price, quota and capacity search | No. Read-only calls only. |
| **spawn** | Launches and manages instances; creates the instance roles they run under | Yes |
| **spored** | Agent on every spawn instance: TTL, idle, completion and cost limits, DNS registration | Yes, but only on its own instance (below) |
| **lagotto** | Watches for capacity and launches when it appears; optional hosted poller in your account | Yes, through the launch settings you give a watch |
| **spore-host-mcp** | MCP server for AI assistants: truffle search, spawn list/status/stop/extend/terminate, `spawn_task_run`, lagotto watches | Yes. It can launch billable instances (TTL required), stop and terminate (terminate needs a confirming second call), and create watches |
| **spore-bot** | Chat control and notifications (Slack, Teams, Discord) | **Experimental, off by default; the hosted bot is decommissioned** (below) |
| **plugins** ([spore-plugins](https://github.com/spore-host/spore-plugins)) | Optional post-launch installers | Run as root on the instance you install them on |

---

## What leaves your account

- **AWS APIs** in the regions you choose, called with your credentials.
- **The spored binary** is downloaded from a public, regional S3 bucket
  (`spawn-binaries-<region>`) and verified before it runs (see
  [Supply chain](#supply-chain)).
- **DNS registration, on by default.** At boot spored registers
  `<name>.<account-slug>.spore.host` with spore.host's DNS updater, a Lambda
  in the spore.host infra account (966362334030). The request carries the
  record name, the instance's public IP and the action. It is SigV4-signed with
  the instance role, so the updater also learns the caller's account and
  instance. `spawn launch --no-dns` (or `dns.enabled: false` in
  `~/.spawn/config.yaml`) turns it off, and a
  [self-hosted updater](docs/guides/self-hosting.md) keeps it in your account.
- **Chat notifications**, only if you opt into the experimental chat
  integration and run your own spore-bot (see [spore-bot](#spore-bot)).

There is no telemetry or analytics.

**Where to check:** `spawn/pkg/dns/client.go` (`DNSUpdateRequest`,
`signRequest`); `spawn/pkg/config/endpoints.go` (`DefaultDNSFunctionARN`);
`spawn/cmd/launch_flags.go` (`--no-dns`); [docs/architecture.md](docs/architecture.md).

---

## Permissions for your own identity

### truffle

truffle calls only read APIs:

- **EC2:** `DescribeInstanceTypes`, `DescribeInstanceTypeOfferings`,
  `DescribeRegions`, `DescribeAvailabilityZones`, `DescribeInstances`,
  `DescribeSpotPriceHistory`, `DescribeCapacityReservations`,
  `DescribeCapacityBlockOfferings` and `GetSpotPlacementScores`;
- **Price List:** `pricing:GetProducts`;
- **Service Quotas:** `servicequotas:GetServiceQuota` and `ListServiceQuotas`.

It makes no write call. `ReadOnlyAccess` covers it.

**Where to check:** `truffle/pkg/aws/` (every SDK call); the quota statement in
[docs/reference/iam-permissions.md](docs/reference/iam-permissions.md#service-quotas).

### spawn

Use the
[recommended least-privilege baseline](docs/reference/iam-permissions.md#recommended-least-privilege-baseline).
Each of its actions is traced to the spawn code that calls it. Its properties:

- **IAM writes need spawn's permissions boundary.** `iam:CreateRole`,
  `iam:PutRolePolicy` and `iam:AttachRolePolicy` on spawn's instance roles are
  allowed only when the role carries the boundary
  `arn:aws:iam::<account>:policy/spore-host/spawn-instance-boundary`. Explicit
  Denies refuse edits to the boundary and `DeleteRolePermissionsBoundary`.
- **Ownership tags are written only at creation.** `ec2:CreateTags` is allowed
  only inside the request that creates a resource (`ec2:CreateAction`), except
  for spawn's own `spawn:*` and `spore:plugin:*` keys on instances already
  tagged `spawn:managed=true`. An explicit Deny refuses writing or deleting the
  ownership keys (`spawn:managed` and the others listed on the page) on an
  existing resource.
- **Stop, start, terminate and `ssm:SendCommand` are conditioned on
  `spawn:managed=true`.** The scoping above keeps that tag from being added to
  an instance spawn didn't launch.

**Don't use `PowerUserAccess` for spawn.** It grants `ec2:CreateTags` on every
resource with no condition, so its holder can put `spawn:managed=true` on any
instance, and every tag-scoped grant stops being scoped. An earlier version of
this page and of the baseline allowed IAM role writes with no boundary, which
let a holder give an instance any permissions
([GHSA-grc9-fj4x-rx6w](https://github.com/spore-host/spore-host/security/advisories/GHSA-grc9-fj4x-rx6w)).
Remove it if you applied it.

**One-time administrator step.** An administrator creates the boundary once per
account with `spawn setup-account` (spawn v0.164.0+), or the first launch an
administrator runs creates it. The baseline cannot create it, on purpose. Until it exists, a launch that must create or update an
instance role is refused, and the error names the command.
`spawn cleanup --instance-roles` deletes the boundary once no role uses it.

**Which instances spawn acts on.** spawn's list, stop, terminate and cleanup
commands select instances tagged `spawn:managed=true`. Under the baseline,
IAM enforces this as well, for the reasons above. Under a broader policy, such
as administrator credentials, spawn can do whatever that policy allows. The
tag filter is a CLI convention, not a guarantee.

**Where to check:** [docs/reference/iam-permissions.md](docs/reference/iam-permissions.md);
`scripts/check_iam_doc_policies.py` (CI: no unconditioned `ec2:CreateTags`, no
role write without a boundary condition); `spawn/cmd/setup_account.go`;
`spawn/pkg/aws/iam_boundary.go`; `spawn/pkg/aws/client.go` (`ListInstancesInRegions`,
filter `tag:spawn:managed`).

---

## Roles spawn creates for instances

spawn creates `spored-instance-role` (with `spored-instance-profile`), the
`spawn-instance-*` family (for `--iam-*` launches), `spawn-instance-app` (for
`spawn app launch`), worker-pool roles and the cross-account sweep role. Since
spawn v0.164.0, **every one of them carries the permissions boundary**: at
`CreateRole` for a new role, and with `PutRolePermissionsBoundary`, before any
policy is written, for an existing one.

### The permissions boundary

The boundary allows a broad data-plane ceiling, and denies:

- IAM administration;
- `organizations:*` and `account:*`;
- `sts:AssumeRole` into another account (`aws:ResourceAccount` differs from
  `${aws:PrincipalAccount}`).

Whatever is written onto a role, including your own `--iam-policy-file` or
`--iam-managed-policies`, an instance can't use it to escalate in IAM or reach
another account.

**What it doesn't do:** within the ceiling, a caller can still give an instance
data-plane access the caller doesn't hold, for example S3 on a bucket their own
identity can't read. IAM can't express "role ⊆ caller". If that matters to you,
narrow the boundary's resource scopes, or launch with `--instance-profile`
naming a profile you manage.

### What spored's role can reach

`spored-instance-role` (grant schema 3, spawn v0.164.0+) holds:

- **EC2 reads on `*`:** `DescribeTags`, `DescribeInstances`, `DescribeVolumes`
  and `DescribeSpotPriceHistory`. Describe calls can't be resource-scoped, so
  an instance can read every instance's tags in the account.
- **Changes to its own instance only:** `CreateTags`/`DeleteTags`,
  `StopInstances` and `TerminateInstances`, all conditioned on
  `aws:ARN == ${ec2:SourceInstanceARN}`. Explicit Denies retire the account-wide
  forms that CLIs up to v0.161.0 still write.
  - An instance can't write the keys the reaper and the dashboard act on, even
    on itself: `spawn:managed`, `spawn:launch-time`, `spawn:pre-stop`,
    `spawn:pre-stop-timeout`, `spawn:local-username`, `spawn:config`,
    `spawn:iam-user`, `spawn:nested-parent` and the Elastic IP ownership keys.
  - `CancelSpotInstanceRequests` is allowed on `spawn:managed=true` requests.
  - It may release only an Elastic IP tagged with its own instance ARN.
- **S3 reads:**
  - the public `spawn-binaries-*` buckets;
  - `spawn-schedules-*`;
  - `dcv-license.*` objects;
  - its own launch-config object. spored refuses an object that doesn't hash
    to the instance's `spawn:config` tag.
- **Other services:**
  - `lambda:InvokeFunctionUrl` on spore.host's DNS updater;
  - ECR image pull;
  - FSx describe and `CreateDataRepositoryAssociation`, plus
    `iam:CreateServiceLinkedRole` limited to the FSx-S3 service;
  - four item-level DynamoDB actions on `spawn-hybrid-registry` in its own
    account.
- **SSM:** the AWS-managed `AmazonSSMManagedInstanceCore`, so the instance
  registers with Session Manager.
- **An explicit Deny on the account's wildcard TLS key.** Only
  `spawn-instance-app` may read it.

So code running on a spawn instance can read the account's instance metadata
and tags and the S3 objects above. It can't stop, terminate or retag another
instance, and it can't change IAM. `--nested-spawn` heads may also manage the
children they launched, which are tagged at launch with the head's
`aws:userid`, and nothing else.

**Where to check:** `spawn/pkg/aws/iam.go` (`sporedDCVRolePolicy`,
`sporedSelfManagementStatements`, `reaperControlTagKeys`);
`spawn/pkg/aws/iam_instance_scope.go`; `spawn/pkg/aws/iam_policy_schema.go`
(schema history); `spawn/pkg/aws/iam_boundary.go`; `spawn/CHANGELOG.md` 0.164.0.

---

## Instance hardening

- **IMDSv2 on every launch** (spawn v0.165.0+): `HttpTokens=required` with a
  hop limit of 1. That covers `spawn launch`, sweeps, pipeline stages, nested
  spawn, `spawn app`, `spawn task run` and `pkg/launcher` callers such as
  lagotto. The exceptions are hop limit 2 for a `spawn task run` container and
  for `pkg/launcher` container launches, whose bridged container needs the
  instance role, and `--imds-hop-limit` when you set it. Web-app containers
  keep 1, so a publicly reachable app can't fetch the role's credentials.
- **Security groups spawn creates** (spawn v0.165.0+):
  - The DCV (`spawn-dcv`), web (`spawn-web`) and MPI (`spawn-mpi-*`) groups
    don't open SSH to the internet. When spawn reuses such a group created by
    an older release, it removes a `0.0.0.0/0` or `::/0` SSH rule.
  - The DCV and web groups do open their service ports (DCV 8443, HTTPS 443)
    to the internet. That's what they're for.
  - `spawn app launch` refuses an existing `spawn-dcv`/`spawn-web` group that
    isn't tagged `spawn:managed=true`.
  - **Windows:** with no `--security-group-ids`, a Windows launch creates
    `spawn-windows-<name>`, opening RDP (3389) and SSH (22) to `--allow-cidr`.
    The default is `0.0.0.0/0`, with a printed warning. Pass
    `--allow-cidr <your-ip>/32`, or your own group.
  - `spawn connect` uses SSM Session Manager when no group admits SSH.
- **No session tokens in tags** (spawn v0.164.0+). DCV and web-app session
  tokens are minted on your machine. Only their SHA-256 is registered on the
  instance, over SSM. Each expires (12 hours by default), and a stop/start
  clears them all. spored deletes the token-bearing tags an older spored left.
- **Plugin values sealed over SSM** (spawn v0.164.0+). `spawn plugin` calls that
  go over SSM are encrypted end to end to a single-use key held only in
  spored's memory (HPKE, ML-KEM-768 + X25519), so plugin config never sits in
  clear in SSM command history. spawn refuses the SSM path to a spored too old
  to support it.
- **Secrets stay out of user data** (spawn v0.165.0+). A launch refuses a
  plugin declaration whose config sets a secret-looking key, because user data
  is readable with `ec2:DescribeInstanceAttribute`. Set secrets after launch
  with `spawn plugin install … --config`. `/etc/spawn/plugins.json` is 0600.
- **`spawn connect --rdp`** (spawn v0.165.0+). The instance generates the
  Administrator password and returns it encrypted to a single-use key held by
  your running `spawn`, so the SSM command history holds no password.
- **Local files** (spawn v0.165.0+): `~/.spawn`, `~/.spawn/sessions` and
  `~/.spawn/sweeps` are 0700, and session files are 0600.

**Where to check:** `spawn/pkg/aws/imds.go`; `spawn/pkg/aws/securitygroup.go`
(`retireWorldSSH`, `CreateOrGetWindowsSecurityGroup`); `spawn/cmd/launch_single.go`;
`spawn/cmd/spored/access_token.go`; `spawn/pkg/pushseal/`; `spawn/CHANGELOG.md`
0.164.0 and 0.165.0.

---

## Supply chain

- **spored binaries.** Each release is signed with a spore.host KMS asymmetric
  key (ECDSA P-256; the private key never leaves KMS). The bootstrap verifies
  the signature with `openssl`, against a public key compiled into spawn,
  before spored runs, and fails closed (spawn v0.91.1+). The trust root is the
  spawn binary, not the bucket. Since v0.165.0, each release also signs a
  manifest of the binary's name, version and SHA-256 (`<name>.msig`). The Linux
  and Windows installers rebuild it from what they asked for and what they
  downloaded, so an older signed spored, or another architecture's, at the
  current path is refused. The `.sha256` beside each binary catches a corrupt
  download, and only that: it comes from the same bucket.
- **Windows bootstrap** (v0.165.0+). It runs the AWS CLI MSI and the SSM agent
  installer only if they carry a valid Amazon Authenticode signature.
- **Amazon DCV install** (v0.165.0+). The signing key must import and every
  RPM must pass `rpm -K`. Otherwise nothing installs.
- **Plugins.** Official plugin releases are signed keyless with cosign in the
  spore-plugins release workflow. spawn verifies the signature for every
  official install, pinning the issuer (GitHub Actions) and the SAN (that repo's
  `release.yml`). A missing or invalid signature fails. A bare plugin name is
  verified too
  ([GHSA-54x4-pc23-4m6j](https://github.com/spore-host/spawn/security/advisories/GHSA-54x4-pc23-4m6j)).
  A spec whose `fetch` step has no `sha256` is refused for every source, and
  `--insecure` doesn't bypass that.
- **This repo's CI** pins every Action by commit SHA and every container image
  by digest, and checks a pinned sha256 for each downloaded tool
  (`scripts/check_workflow_pins.py`). Dependabot covers every manifest
  (`scripts/check_dependabot_coverage.py`).

**Where to check:** `spawn/pkg/sporedinstall/` (`manifest`, `windows.go`);
`spawn/scripts/install-spored.ps1`; `spawn/pkg/plugin/signature.go`;
`.github/workflows/`, `scripts/` in this repo.

---

## Lifecycle enforcement

- **spored enforces TTL, idle timeout, completion and `--cost-limit` from
  inside the instance**, so they work with your laptop off. `spawn extend`
  moves the deadline. A user with root on the instance can stop spored, so
  spored alone doesn't guarantee termination.
- **The out-of-band TTL reaper** (`spawn/lambda/ttl-reaper`) is the backstop.
  It terminates past-deadline `spawn:managed` instances even if spored has
  stopped. It's optional, deployed in your account or against a narrow
  cross-account role you create, and its template defaults to `DryRun=true`
  (it logs "WOULD reap" and terminates nothing until you flip it). The instance
  can't write the tags the reaper relies on (see
  [What spored's role can reach](#what-sporeds-role-can-reach)).
- AWS-side controls remain yours: Budgets, SCPs, Cost Anomaly Detection. Cost
  allocation can use the `spawn:*` tags.

### Lifecycle guarantee by deployment mode

| Mode | spored (in-instance) | Out-of-band reaper | What happens if spored is stopped |
|---|:---:|:---:|---|
| **CLI only** (default) | yes | no | Nothing ends the instance at its deadline. Only your AWS-side controls (Budgets, SCPs) remain. |
| **With the reaper**, enforcing | yes | yes, in your account or through the cross-account role you grant | The reaper terminates past-deadline `spawn:managed` instances. |
| **With the reaper**, `DryRun=true` (its default) | yes | logs only | As for CLI only: the reaper reports "WOULD reap" and terminates nothing. |

With no reaper, spored is the whole guarantee. `spawn status` shows whether it
is running and which deadline it holds. What leaves your account doesn't depend
on the mode: see [What leaves your account](#what-leaves-your-account).

**Where to check:** `spawn/pkg/agent/`; `spawn/lambda/ttl-reaper/template.yaml`
(`DryRun`); [docs/safety.md](docs/safety.md).

---

## lagotto

From lagotto v0.70.0:

- **The hosted poller doesn't create or modify IAM roles.**
  - Its runtime policy has no `iam:CreateRole`, `iam:PutRolePolicy`,
    `iam:AttachRolePolicy` or instance-profile writes.
  - `iam:PassRole` is granted only on exact role ARNs: `lagotto-instance-role`
    and the roles an administrator authorizes with
    `lagotto setup --instance-role` (to EC2) or `--sagemaker-role` (to
    SageMaker).
  - SageMaker job actions are limited to `training-job/lagotto-*`.
- **Launch settings are validated** when a watch is created and again by the
  poller before each launch.
  - Inline IAM policies are refused.
  - `iam_role` can't name a `spored*` role, a nested-spawn role or a poller
    role.
  - A stored watch that breaks these rules fails without launching.
- **Watches are isolated per owner by IAM, not by the client.** Every watch,
  group, history row and scheduled launch is keyed under its creator's
  principal id. `lagotto-cli-user` allows DynamoDB item access only under the
  caller's own `${aws:userid}` (`dynamodb:LeadingKeys`), with no `Scan`.
- A watch with no `iam_role` launches with `lagotto-instance-role`, which
  carries spawn's spored/SSM baseline, not spawn's shared `spored-instance-role`.

Upgrade order matters: deploy the new poller, run `lagotto setup`, then upgrade
the CLI. See `lagotto/CHANGELOG.md` 0.70.0.

**Where to check:** `lagotto/pkg/runtimeiam/runtimeiam.go`;
`lagotto/pkg/cliiam/cliiam.go`; `lagotto/pkg/watcher/keys.go`.

---

## spore-bot

Chat integrations (Slack, Teams, Discord) and the SMS notifications that go
through spore-bot are **experimental and outside the supported surface**.

- Since spawn v0.163.0, every spawn entry point for them refuses unless you set
  `SPAWN_EXPERIMENTAL_CHAT=1` (or `experimental: {chat: true}` in
  `~/.spawn/config.yaml`), and a launch without it configures no
  notifications.
- **spore.host's hosted spore-bot is decommissioned.** Its Function URL is
  removed (`public_endpoint_enabled = false` in `infra/tofu/spore-bot`), and
  spawn has no default bot endpoint: an opted-in launch needs
  `SPORE_NOTIFY_URL` pointing at your own deployment.
- If you self-host it, spore-bot assumes a narrow cross-account role you create
  (`spawn/deployment/cloudformation/bot-cross-account-role.yaml`). That
  template refuses account 942542972736.
- Workspace credentials are sealed with KMS at rest.

**Where to check:** `spawn/CHANGELOG.md` 0.163.0; `spawn/cmd/launch_flags.go`;
`infra/tofu/spore-bot/main.tf` (`public_endpoint_enabled`); `lambda/spore-bot/`.

---

## Audit and compliance

spawn's AWS calls are made with your credentials, so CloudTrail records them
under your identity. spored's are recorded under the instance role, with the
instance id as the session name.

```bash
# Instances spawn launched
aws ec2 describe-instances --filters "Name=tag:spawn:managed,Values=true" \
  --query 'Reservations[].Instances[].[InstanceId,LaunchTime,State.Name]'

# Terminations by an instance role (session name = instance id)
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=TerminateInstances \
  --query 'Events[?contains(CloudTrailEvent, `spored-instance-role`)]'
```

spawn also writes a structured JSON audit log of its own operations to stderr
(`spawn/pkg/audit`).

**Compliance:** spore.host doesn't receive or store your workload data, so it
can't make a workload compliant. CloudTrail, tags and automatic cleanup are
inputs to your controls, not attestations.

---

## Published advisories

The 2026-11 pre-release audit
([spore-host#649](https://github.com/spore-host/spore-host/issues/649)) is
published as:

| Advisory | Repo | Severity | Fixed in |
|---|---|---|---|
| [GHSA-2wr7-4wpw-vr72](https://github.com/spore-host/spawn/security/advisories/GHSA-2wr7-4wpw-vr72): session bearer tokens and plugin secrets in account-readable metadata (EC2 tags, SSM command parameters) | spawn | high | v0.164.0 |
| [GHSA-7p5f-6x8r-9f82](https://github.com/spore-host/spawn/security/advisories/GHSA-7p5f-6x8r-9f82): spored and nested-spawn roles allowed lateral movement between instances | spawn | high | v0.164.0 |
| [GHSA-8p8w-pxv2-36xf](https://github.com/spore-host/spawn/security/advisories/GHSA-8p8w-pxv2-36xf): DNS records repointable by any principal in an account; instances could read the wildcard TLS key | spawn | medium | v0.164.0 |
| [GHSA-2c3j-89xf-ph78](https://github.com/spore-host/spawn/security/advisories/GHSA-2c3j-89xf-ph78): dashboard-api accepted any valid AWS credentials as a user | spawn | low | v0.164.0 |
| [GHSA-cwvg-2289-jmv3](https://github.com/spore-host/lagotto/security/advisories/GHSA-cwvg-2289-jmv3): poller as confused deputy for arbitrary instance IAM policies | lagotto | high | v0.70.0 |
| [GHSA-8mcw-8jh4-9hmg](https://github.com/spore-host/lagotto/security/advisories/GHSA-8mcw-8jh4-9hmg): watch ownership enforced client-side only | lagotto | medium | v0.70.0 |
| [GHSA-grc9-fj4x-rx6w](https://github.com/spore-host/spore-host/security/advisories/GHSA-grc9-fj4x-rx6w): documented spawn baseline allowed escalation to account admin | spore-host | high | docs, main@6ac3fad |
| [GHSA-h4qv-6m56-mgxp](https://github.com/spore-host/spawn-ts/security/advisories/GHSA-h4qv-6m56-mgxp): demo portal ran an unauthenticated launch/terminate/SSM broker | spawn-ts | high | demo removed, main@73f4153 |

Earlier advisories are listed on each repo's Security tab, for example
[spawn](https://github.com/spore-host/spawn/security/advisories) and
[spore-host](https://github.com/spore-host/spore-host/security/advisories).
Findings from the audit that are still open are tracked privately or as
Hardening issues.

---

## Reporting a vulnerability

Report privately through GitHub's **private vulnerability reporting**:

- this repo:
  [spore-host/spore-host → Report a vulnerability](https://github.com/spore-host/spore-host/security/advisories/new);
- or the Security tab of the affected component's own repo (spawn, truffle,
  lagotto, spore-host-mcp, and the others), where it is also enabled.

Please don't open a public issue, discussion or pull request for a
vulnerability. Fixes are disclosed as GitHub Security Advisories in the repo
that ships them.

---

## Further reading

- [IAM permissions](docs/reference/iam-permissions.md)
- [Security, credentials & data flow](docs/architecture.md)
- [Costs & safety guarantees](docs/safety.md)

This page tracks the current code, not a specific release. Component behaviour
is versioned in each repo's `CHANGELOG.md`.
