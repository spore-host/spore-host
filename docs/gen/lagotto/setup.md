## `lagotto setup`

Provision lagotto's backend: the DynamoDB tables it uses to store watches and
match history (lagotto-watches and lagotto-match-history by default; override with
--watches-table / --history-table), and both CLI-owned IAM roles: the poller's
execution role (lagotto-capacity-poller-role) with the runtime IAM policy that lets
the poller spawn/hold/submit, and the role EventBridge Scheduler assumes to invoke
the poller (lagotto-capacity-poller-scheduler-invoke). The roles are account-global,
so one run in any region serves every region. Roles that already exist are reused;
both policies are rewritten on every run. Setup prints each role it created.

The table creation is idempotent (existing tables are left untouched) and normally
automatic: 'lagotto watch' creates the tables on first use. Run 'setup' explicitly
to provision the backend ahead of time, or — importantly — after 'lagotto deploy'
to grant the poller its permissions. 'deploy' creates only a minimal execution
role (so the runtime Lambda can never self-escalate); 'setup', run by you, attaches
the spawn/hold/SageMaker/scheduler policy. Until then the poller can only notify.
'lagotto teardown --iam-roles' deletes both roles once no region runs a poller.

It also writes the customer-managed policy lagotto-cli-user (lagotto#232): the
least-privilege permissions the everyday commands need with YOUR credentials
(watch, update, ack, extend, cancel, list, status, history, launch, notify-gc,
doctor), resource-scoped to lagotto's tables, schedules, topic, roles and poller.
It is generated from the CLI's own AWS calls (docs/reference/cli-iam-actions.md).
Attach it to the group, users or roles that run lagotto. A re-run that changes
it writes a new default version (deleting the oldest when IAM's limit of five is
reached); an unchanged one is left alone. 'poll', 'setup', 'deploy' and
'teardown' are not covered: they need administrator permissions. s3:// spawn
configs are readable only from the buckets you name with --config-bucket; those
are carried forward on later runs. 'lagotto teardown --iam-roles' detaches and
deletes the policy.

```
lagotto setup [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--config-bucket` |  | stringArray |  | Let the lagotto-cli-user policy read s3:// spawn configs from this bucket (repeatable; s3:GetObject on its objects). Kept on later runs until revoked. |
| `--instance-role` |  | stringArray |  | Authorize the hosted poller to use this IAM instance role when a watch's spawn_config names it in iam_role (repeatable). Without this the watch waits for capacity, matches, then dies at launch with AccessDenied. NOTE: this lets the poller write an inline policy to and attach a managed policy to that role, not merely pass it — spawn adds its spored/SSM baseline to every role it launches with. |
| `--revoke-config-bucket` |  | stringArray |  | Remove a bucket granted with --config-bucket (repeatable). Takes precedence over --config-bucket for the same name. |
| `--revoke-instance-role` |  | stringArray |  | Remove a previously authorized instance role (repeatable). Takes precedence over --instance-role for the same name. |

