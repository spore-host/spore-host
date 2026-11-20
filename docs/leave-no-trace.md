---
description: "Every spore.host tool removes what it created once nothing it manages is active. What each tool creates, when it goes, and the few things that stay, and why."
---

# Leave no trace: what remains and why

**The rule:** every spore.host tool removes everything it created in your
account once nothing it manages has been active for 24 hours.

Each tool tags what it creates with `spore-host:managed-by=<tool>`, can list
it (`<tool> footprint`) and can remove it (`<tool> teardown --plan`). Only a
component that can see every activity signal decides that a tool is idle, and
one user's teardown can't race another user's setup in a shared account (see
[the lease](#shared-accounts-the-lifecycle-lease)).

While an account is set up for spore.host, exactly two things stay
permanently: the permissions boundary `spore-host/spawn-instance-boundary` and
the user lifecycle policy `spore-host/spawn-user-lifecycle`. Both are
removed by `spawn setup-account --remove`. A few other things persist only
while you're onboarded, or until a later step removes them. Each is listed
below with the reason and the command that removes it.

::: warning Status: report mode
Most of what this page describes is merged but not yet released: it came after
spawn v0.167.0, lagotto v0.71.0 and calque v0.6.0. `spawn setup-account
--remove`, the `spore-host/spawn-user-lifecycle` policy and
`lagotto history export` are in review
([spawn#1669](https://github.com/spore-host/spawn/pull/1669),
[lagotto#339](https://github.com/spore-host/lagotto/pull/339)).
**Idle teardown runs in report mode:** it
works out and logs what it would delete, and deletes nothing. Reaping is
switched on one tool per release: lagotto
([lagotto#328](https://github.com/spore-host/lagotto/issues/328)), calque
([calque#229](https://github.com/spore-host/calque/issues/229)), spawn
([spawn#1657](https://github.com/spore-host/spawn/issues/1657)), then the CLI
last mile ([libs#79](https://github.com/spore-host/libs/issues/79)). The
tracking epic is
[spore-host#752](https://github.com/spore-host/spore-host/issues/752).
:::

## What each tool creates, and when it goes

"Idle" means nothing the tool manages is active, by every signal the deciding
component can read. A signal it can't read counts as active. The grace is
24 hours from the moment the tool was last seen active.

### spawn

**What it creates:** instances and their volumes, Spot requests, security
groups, placement groups, imported key pairs, Elastic IPs, the
`spored-instance-role` and `spawn-instance-*` roles with their instance
profiles, the `spore-host/spored-*` managed policies, pool queues
(`spawn-pool-*`), FSx filesystems, the `spawn-staging-*` and
`spawn-results-*` buckets, and, if you deploy one, a self-hosted TTL reaper.

**Who decides it's idle:** the TTL reaper's account-idle sweep. That's the
operated reaper for onboarded accounts, or your own from
`spawn reaper deploy`. Per region, and for the account-wide IAM scope, spawn
is active while any of these is live:

- an instance from pending to stopped;
- an egress proxy;
- an FSx filesystem being made or just made;
- a pool queue with workers or messages;
- a sweep or pipeline that isn't finished, or a schedule that will still fire;
- anything calque classes active.

**When it goes:** 24 hours after the last of those (`--account-idle-grace`,
`REAPER_ACCOUNT_IDLE_GRACE`). The sweep takes the teardown lease, checks
again, plans with the same scan and rules as `spawn footprint`, and logs
`account-idle REPORT account=<id> region=<scope> would_delete=N kept=M`. It
deletes nothing until spawn#1657 (`--account-idle off|report|reap`; `reap`
still reports).

What the plan may delete is narrow. A resource must be tagged
`spore-host:managed-by=spawn`, have a name spawn's teardown registers, and
not be in use, permanent or user data. It never includes the two permanent
pieces.

**A self-hosted reaper removes itself** once every scope it scans has been
idle past the grace and its artifact bucket holds only its own code. It never
deletes its own function, role or log group from inside itself. It hands them
to one-shot EventBridge Scheduler jobs in the group `spawn-reaper-teardown`,
run as the role `spawn-reaper-teardown-invoke`:

| Offset | Deletes |
|---|---|
| +2 min | the reaper function |
| +4 min | its role's policies |
| +5 min | its role (kept while another region's reaper shares it) |
| +15 min | its log group |

Then it deletes its artifact bucket (only if tagged `spawn:managed=true`), and
last its two EventBridge rules, their targets and its invoke permissions. This
is report mode too (`spawn reaper deploy --self-removal off|report|reap`). The
operated reaper never removes itself. To remove a reaper by hand, use
`spawn reaper teardown`; see [The TTL reaper](./guides/reaper.md#removing-it).

### lagotto

**What it creates:** per region, the capacity-poller function
`lagotto-capacity-poller`, its log group, role and schedule; the tables
`lagotto-watches`, `lagotto-match-history` and `lagotto-scheduled-launches`;
the artifact bucket `lagotto-lambda-<account>-<region>`; the topic
`lagotto-capacity-alerts`; per-launch schedules; and, account-wide,
`lagotto-instance-role` and the user `lagotto-cli-user`.

**Who decides it's idle:** the deployed poller, per region. A region is
active while there's an active watch, a pending or retrying scheduled launch,
a held capacity reservation, or a SageMaker job running for a watch. A region
with no poller (`lagotto watch --local` only) is never judged idle.

**When it goes:** 24 hours after the last of those (`LAGOTTO_IDLE_GRACE` on
the function changes the grace). It's report-only until lagotto#328. **Match
history is deleted with the teardown** (owner decision). Export it first with
`lagotto history export --out history.jsonl`.

The full order, and the one-shot self-removal jobs (function at +2 min, role
at +4/+5 min, log group at +15 min), are in lagotto's
[DEPLOYMENT.md](https://github.com/spore-host/lagotto/blob/main/DEPLOYMENT.md#idle-teardown-what-lagotto-removes-when-nothing-is-active).

::: tip Why the log group goes last
Lambda's final log flush recreates a deleted log group within seconds,
untagged and with no retention. So each tool deletes its function first and
its log group about 15 minutes later.
:::

### calque

**What it creates:** the `calque-pool-worker` and `calque-fleet-worker` roles,
per-run `calque-real-run-*` roles, their instance profiles, pool and run
queues, the `calque-nfs-sg` security group, AMIs baked by `calque ami bake`,
and objects under `runs/`, `fleet/` and `ami-bake/` in buckets you name.

**Who decides it's idle:** calque launches through spawn pools, so spawn's
reaper counts calque's active resources as spawn activity
(`pkg/calquefootprint`). calque's own teardown in reap mode is calque#229.
Until then, `calque teardown` is the path (below).

### truffle

truffle creates nothing in your account. It only reads (instance types,
prices, quotas, capacity).

## What stays, and why

### The two permanent pieces: what `spawn setup-account` provisions

`spawn setup-account` is the one admin step. It creates the only two things
spore.host keeps in an account while it's set up: two customer-managed
policies, both permanent account setup, tagged `spore-host:managed-by=spawn`
and `spore-host:permanent=true`:

- **`spore-host/spawn-instance-boundary`**, the permissions boundary that caps
  every role spawn creates (see
  [The permissions boundary](./reference/iam-permissions.md#the-permissions-boundary)).
  Deleting it while any role still uses it would leave those roles uncapped.
- **`spore-host/spawn-user-lifecycle`**, which grants spawn users the
  lifecycle-lease actions. An administrator attaches it to the groups or roles
  spawn users sign in with (see
  [The lifecycle lease](./reference/iam-permissions.md#the-lifecycle-lease)).
  Like the boundary, it's permanent account setup: an administrator attached
  it, and deleting it would break their setup.

No idle teardown, `spawn cleanup` or `spawn teardown` deletes either.
`spawn footprint` classes both `permanent`. `spawn setup-account --remove` is
the only way either goes. An administrator runs:

```sh
spawn setup-account --remove          # prints the plan; deletes nothing
spawn setup-account --remove --yes    # deletes
```

`--remove` refuses, and deletes nothing, while any role or user still has the
boundary as its permissions boundary. It names those roles, so you can delete
them first (`spawn teardown --plan`, `spawn cleanup --instance-roles`). It also
refuses in spore.host's infra account.

Otherwise it deletes in this order:

1. The user policy. It's detached from every group, user and role it's
   attached to, then its older versions are deleted, then the policy.
2. The boundary, last. Its use is read again first, then its older versions
   are deleted, then the policy.

### What persists while you're onboarded

An account onboarded to the spore.host portal or to the operated reaper keeps
what connects it:

- **`spore-portal-onboard`**, the role the portal uses in your account. It's
  created by `spawn onboard` or the portal's CloudFormation quick-create. It's
  also the record that you consented, so nothing removes it automatically.
  When you leave:

  ```sh
  spawn setup-account --remove --offboard          # plan
  spawn setup-account --remove --offboard --yes    # deletes it with the two policies
  ```

  This deletes the role's inline policies, its attachments, then the role. If
  the role was made by the CloudFormation quick-create stack, `--offboard`
  refuses and names the stack. Delete that stack instead
  (`aws cloudformation delete-stack --stack-name spore-portal-onboard`), which
  also removes its phone-home function. Offboarding in your account doesn't
  change the portal's own record of it
  ([spore-host#602](https://github.com/spore-host/spore-host/issues/602)).
- **The reaper's member-account stack** (`spawn-ttl-reaper-ec2`, from
  `ttl-reaper-cross-account-role.yaml`), with the roles `spawn-ttl-reaper-ec2`
  and `spawn-ttl-reaper-ec2-events`. It's what lets a central reaper cover your
  account. Remove it when you leave, with
  `aws cloudformation delete-stack --stack-name spawn-ttl-reaper-ec2`.

Nothing in a spore.host account may reach 942542972736, so all cleanup runs
inside the account it cleans: each tool's backstop, plus your own CLI.

### What stays after a tool's teardown

These are left behind on purpose, and named in the teardown's log:

- **lagotto:** the invoke role `lagotto-capacity-poller-scheduler-invoke` and
  each region's `lagotto-teardown` schedule group. They're what ran the
  self-removal jobs, so they can't delete themselves. The
  [lazy last mile](#the-lazy-last-mile) reports them. Until libs#79 it doesn't
  remove them; remove them with `lagotto teardown --plan`, as below.
- **lagotto's `lagotto-cli-user`**, which the poller can't delete.
  `lagotto teardown --iam-roles` detaches it from every user, group and role,
  then deletes it.
- **spawn's self-hosted reaper:** the role `spawn-reaper-teardown-invoke` and
  the group `spawn-reaper-teardown`, which `spawn reaper teardown` removes.
- **The lease table `spore-host-lifecycle`.** It's shared by every tool. A
  teardown in reap mode deletes it only once no tool's item is left in it.

### Your data is never deleted automatically

Your data stays unless you opt in to deleting it:

- a `spawn-results-*` bucket that holds objects;
- any bucket spawn didn't create;
- AMIs and snapshots, including calque's baked images;
- a workstation key pair;
- an Elastic IP spawn didn't allocate.

The footprint classes all of these `user-data`, and no teardown deletes them.
A results bucket goes only once it's provably empty. To expire results by
rule, see [Keeping results](./guides/results-retention.md).

## Inspect what's there

Each tool lists what it created. Run it with nothing active to see exactly
what remains:

```sh
spawn footprint --all-regions
lagotto footprint --all-regions
calque footprint --all-regions
```

`-o json` gives every resource in the shared footprint schema, with these
fields:

- its **ownership**: `tagged`, `legacy-name` (matched only by name or an old
  tag, so it's reported but never deleted) or `foreign`;
- its **class**: `permanent`, `user-data`, `active`, `residue` or `litter`;
- whether it's **deletable**, and why.

## Tear down by hand

The same plan the automatic teardown uses, run yourself:

```sh
spawn footprint --all-regions -o json > plan.json
spawn teardown --plan plan.json                 # report: re-checks, deletes nothing

lagotto footprint --all-regions -o json > lagotto.json
lagotto teardown --plan lagotto.json            # report
lagotto teardown --plan lagotto.json --mode reap --yes

calque footprint --all-regions -o json > calque.json
calque teardown --plan calque.json              # report
calque teardown --plan calque.json --mode reap --yes
```

Every resource is read again before anything happens to it. Anything in use
is kept, along with everything it depends on. `--mode reap` takes the
shared-account lease.

`spawn teardown --mode reap` still refuses until spawn's teardown takes the
lease itself (spawn#1657). Until then, `spawn cleanup` covers spawn's
instance-level resources. Other ways to remove things by hand:

- `lagotto teardown --iam-roles` removes lagotto's poller roles, its instance
  role and `lagotto-cli-user`, detaching it first.
- `spawn reaper teardown` removes a self-hosted reaper.
- `spawn setup-account --remove` removes the two permanent pieces.

## Shared accounts: the lifecycle lease

Before spawn creates anything a teardown could delete, it marks spawn active
in the DynamoDB table `spore-host-lifecycle`. There's one table per region,
plus `us-east-1` for account-wide IAM. A teardown takes the lease, with an
epoch and a fencing token, and checks again before deleting. A launch that
starts while a teardown holds the lease waits for it.

An account whose users can't write the table is "lease unavailable". It's
never idle-torn-down, because nothing would stop a teardown racing a launch.
`spawn setup-account` creates the policy `spore-host/spawn-user-lifecycle`
for this; attach it to your spawn users. `spawn doctor` shows whether the
lease is writable, in its "idle teardown" check.

## The report-then-reap rollout

Every deletion path ships in report mode first. It logs exactly what it would
delete, and one release of real report logs is checked before that tool is
switched to reap. Each switch is its own release, one tool at a time.
Switching a mode to `reap` before its release only reports, and says so.

## The lazy last mile

A teardown can be interrupted, and the jobs and roles that ran it can't
delete themselves. So after a successful command, a spore.host CLI checks
whether a teardown in this account was left unfinished. This is the lazy last
mile, shared through `libs/lastmile`.

- **When it runs:** at most once every 6 hours per account, within a 30-second
  budget, using your own credentials. lagotto and calque run it today.
- **What it does:** in report mode it deletes nothing. It reports leftover
  teardown residue, stale leases, empty lease tables, and tool items in
  regions with no deployed backstop. Its findings appear only in the debug
  log: `--verbose` for lagotto, `CALQUE_DEBUG=1` for calque.
- **What it never does:** it never changes a command's exit status or stdout.
  It's skipped for the tool's own `footprint` and `teardown`, and for `help`,
  `version` and `completion`.
- **Turning it off:** `SPORE_LASTMILE=off|report|reap`. Unset means `report`,
  and `reap` still reports until libs#79.

## Opting out

| To | Set |
|---|---|
| Turn spawn's account-idle sweep off, or back to report | `spawn reaper deploy --account-idle off` (or `report`) |
| Give spawn a longer grace | `spawn reaper deploy --account-idle-grace 72h` |
| Stop a self-hosted reaper removing itself | `spawn reaper deploy --self-removal off` |
| Change lagotto's grace | `LAGOTTO_IDLE_GRACE` on `lagotto-capacity-poller`, a Go duration such as `72h` |
| Turn off the CLI last mile | `SPORE_LASTMILE=off` |

lagotto's idle teardown has no off switch. `LAGOTTO_IDLE_GRACE` only changes
its grace, and `lagotto deploy` doesn't set it. A deploy that
rewrites the function's configuration drops it, so set it again after
deploying.

An account that never grants the lease (no `spore-host/spawn-user-lifecycle`
attached) is never idle-torn-down by spawn. It isn't a supported way to opt
out, because what spawn leaves there then stays until you run the commands
above.
