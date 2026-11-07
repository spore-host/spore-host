## `lagotto teardown`

Delete the DynamoDB tables lagotto uses: lagotto-watches,
lagotto-match-history and lagotto-scheduled-launches (the last is created by
'lagotto deploy' or the first 'lagotto launch').

lagotto already tears these down automatically once there are no active watches
or pending scheduled launches and the tables have drained (records age out via
DynamoDB TTL). Use this to remove them explicitly.

By default it refuses to delete tables that still hold records, so you don't lose
match history or a pending scheduled launch; pass --force to delete regardless.
The scheduled-launches table is deleted only if it carries lagotto's
lagotto:managed=cli tag; an untagged table of that name is left in place and
reported. A table that does not exist is skipped.

Before deleting the tables it deletes the per-launch EventBridge Scheduler
schedules 'lagotto launch' creates (lagotto-launch-sl-*): every one a
scheduled-launch record names, and every one in the default schedule group with
that prefix, including the poller's retry schedules and any whose record is
gone. The scheduled-launches table is the only record of those schedules, and a
cron schedule never removes itself, so deleting the table first would leave it
firing indefinitely. A schedule that no longer exists is reported, not an error.
With --force this cancels any pending scheduled launch. If the schedules cannot
be listed or deleted (scheduler:ListSchedules, scheduler:DeleteSchedule),
teardown stops before deleting any table.

--iam-roles also deletes the two IAM roles 'lagotto setup' and 'lagotto deploy'
create (lagotto-capacity-poller-role and lagotto-capacity-poller-scheduler-invoke),
with their policies. The roles are account-global and shared by the poller in every
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

```
lagotto teardown [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--force` |  | bool |  | Delete even if the tables still contain records |
| `--iam-roles` |  | bool |  | Also delete lagotto's two account-global IAM roles and the lagotto-cli-user policy (detached from everyone first); refused while a poller exists in any region |

