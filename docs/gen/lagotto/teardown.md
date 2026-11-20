## `lagotto teardown`

Delete the DynamoDB tables lagotto uses in one region (--region, else your
configured region): lagotto-watches, lagotto-match-history and
lagotto-scheduled-launches. 'lagotto deploy' creates all three with the poller;
'lagotto watch --local' creates the first two in a region with no poller (for a
local 'lagotto poll --daemon'). 'watch', 'launch' and 'setup' create none in a
region with no poller (lagotto#325).

Nothing deletes these tables automatically yet: a deployed poller does not
delete them, and once no watch is active it only slows its schedule to once an
hour. A poller whose function has AUTO_DELETE_TABLES=true set by hand deletes
them once they are empty, provided 'lagotto setup' has been re-run with a lagotto
that includes lagotto#325, which grants the poller dynamodb:DeleteTable (before
that the poller was denied and only logged a warning); 'lagotto deploy' never
sets it.
Automatic idle teardown, after a grace period, is lagotto#326. Until then, run
this to remove them.

By default it refuses to delete tables that still hold records, so you don't lose
match history or a pending scheduled launch; pass --force to delete regardless.
The scheduled-launches table is deleted only if it carries lagotto's
lagotto:managed=cli tag; an untagged table of that name is left in place and
reported. A table that does not exist is skipped.

Before deleting the tables it deletes the per-launch EventBridge Scheduler
schedules 'lagotto launch' creates (lagotto-launch-sl-*): every one a
scheduled-launch record names, and every one with that prefix in lagotto's
schedule group "lagotto" and in the "default" group (where schedules created
before lagotto#324 are), including the poller's retry schedules and any whose
record is gone. Then it deletes the "lagotto" schedule group if nothing is left
in it (a deployed poller's schedule keeps it). The scheduled-launches table is the only record of those schedules, and a
cron schedule never removes itself, so deleting the table first would leave it
firing indefinitely. A schedule that no longer exists is reported, not an error.
With --force this cancels any pending scheduled launch. If the schedules cannot
be listed or deleted (scheduler:ListSchedules, scheduler:DeleteSchedule,
scheduler:DeleteScheduleGroup), teardown stops before deleting any table.

--iam-roles also deletes the two IAM roles 'lagotto setup' and 'lagotto deploy'
create (lagotto-capacity-poller-role and lagotto-capacity-poller-scheduler-invoke),
with their policies, and the instance role 'lagotto setup' creates for launches
(lagotto-instance-role, with its instance profile), plus the instance profile setup
created for each role authorized with --instance-role (the role itself is yours and
is left in place). The roles are account-global and shared by the poller in every
region, so this first checks every region enabled in the account and refuses, before
deleting anything, while a poller still exists in any of them (remove each with
'lagotto deploy --teardown --region &lt;region&gt;') or when a region cannot be checked.
--force does not override that check.

--iam-roles also deletes the customer-managed policy lagotto-cli-user that
'lagotto setup' writes for the people who run lagotto (lagotto#232). IAM refuses
to delete an attached policy, so teardown first DETACHES it from every user,
group and role it is attached to (each is printed; they lose those permissions),
then deletes its non-default versions, then the policy. A policy of that name
without lagotto's lagotto:managed=cli tag is left in place and reported.

--plan &lt;file|-&gt; takes the other path (lagotto#325): it executes a footprint,
the JSON 'lagotto footprint -o json' writes, through the shared spore.host
teardown executor, and none of the above applies (--force and --iam-roles are
refused with it). It first takes the footprint again, of the plan's regions (of
every region when the plan names an account-wide resource), and keeps whatever
is active in either, and everything an active resource depends on: a pending
launch's schedule group, the role an active poller runs as. The rest is deleted
in dependency order (a profile before its role, a schedule before its group,
the poller before its role, topic and tables, each log group after every
function), each one re-checked first: one that is gone is skipped, and one
whose tags or class changed since the plan is refused. Only a resource tagged
spore-host:managed-by=lagotto, with lagotto's name, is ever deleted; never one
tagged spore-host:role=service or spore-host:permanent=true, a legacy-name or
foreign one, a capacity reservation, a training job or the legacy stack. When
one is not removed, nothing it depends on is tried.

--mode report, the default, deletes nothing and says what reap would delete.
--mode reap deletes and needs --yes. It first takes the teardown lease
(lagotto#326) in every region it deletes in, so another user's deploy, watch or
launch there waits for it, or stops it before its next delete. A region where
something is in use, or another teardown holds the lease, refuses the whole
run before anything is deleted. Use -o json for the outcome of every step.

```
lagotto teardown [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--force` |  | bool |  | Delete even if the tables still contain records |
| `--iam-roles` |  | bool |  | Also delete lagotto's account-global IAM roles (the poller's two and its instance role) and the lagotto-cli-user policy (detached from everyone first); refused while a poller exists in any region |
| `--mode` |  | string | `report` | With --plan: report (say what would be deleted; the default) or reap (delete; needs --yes) |
| `--plan` |  | string |  | Execute a footprint plan: the JSON 'lagotto footprint -o json' writes, from a file or - for stdin |
| `--yes` |  | bool |  | With --plan --mode reap: confirm the deletion |

