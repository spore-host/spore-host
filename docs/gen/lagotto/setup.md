## `lagotto setup`

Provision lagotto's account-wide IAM: both CLI-owned IAM roles, the poller's
execution role (lagotto-capacity-poller-role) with the runtime IAM policy that lets
the poller spawn/hold/submit and, once idle, tear its own region down, and the role
EventBridge Scheduler assumes to invoke the poller
(lagotto-capacity-poller-scheduler-invoke) with its InvokeLambda and LagottoTeardown
policies. The roles are account-global, so one run in any region serves every
region. Roles that already exist are reused; their policies are rewritten on every
run. Setup prints each role it created.

Setup creates no DynamoDB table (lagotto#325). The tables are regional and only a
poller uses them, so 'lagotto deploy --region &lt;region&gt;' creates them along with the
poller there, and 'lagotto watch --local' creates them for a local 'lagotto poll
--daemon' in a region with no poller. Setup still tags, and moves older records in,
the tables that already exist in its region.

Run 'setup' after 'lagotto deploy' to grant the poller its permissions. 'deploy'
creates only a minimal execution role (so the runtime Lambda can never
self-escalate); 'setup', run by you, attaches the spawn/hold/SageMaker/scheduler
policy. Until then the poller can only notify. 'lagotto teardown --iam-roles'
deletes both roles once no region runs a poller.

The poller creates and changes no IAM role. Setup creates the one it launches
with by default, lagotto-instance-role (with its instance profile and spawn's
spored/SSM baseline, nothing else), and lets the poller pass only that role, the
roles you name with --instance-role (which must exist; setup creates their
instance profiles) and, for SageMaker watches, the execution roles you name with
--sagemaker-role. Every lagotto user can launch with an authorized role.

Every record a CLI user creates is keyed under the creator's principal id
(&lt;id&gt;/w-…), and lagotto-cli-user lets each caller read and write only the records
under its own id, enforced by IAM (dynamodb:LeadingKeys). Before writing that
policy, setup adds the owner index to a watches table that predates it and moves
every older record (watches, groups, match history, scheduled launches) under its
creator's id: each in one transaction, so nothing is lost or duplicated, and it is
safe to re-run. Records whose creator cannot be resolved are left in place and
listed; the poller still services them.

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

Everything setup creates is tagged spore-host:managed-by=lagotto (with
spore-host:scope, :created, :schema, :component and :owner, your aws:userid),
and the tables, roles, instance profiles and policy an older lagotto created
without those tags gain them. An administrator's own role authorized with
--instance-role is never tagged.

```
lagotto setup [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--config-bucket` |  | stringArray |  | Let the lagotto-cli-user policy read s3:// spawn configs from this bucket (repeatable; s3:GetObject on its objects). Kept on later runs until revoked. |
| `--instance-role` |  | stringArray |  | Authorize the hosted poller to launch with this existing IAM role when a watch's spawn_config names it in iam_role (repeatable). Setup adds spawn's spored/SSM baseline to the role and creates its instance profile; the poller may then only pass it to EC2. Every lagotto user can launch with an authorized role, so authorize only roles whose permissions they may all have. |
| `--revoke-config-bucket` |  | stringArray |  | Remove a bucket granted with --config-bucket (repeatable). Takes precedence over --config-bucket for the same name. |
| `--revoke-instance-role` |  | stringArray |  | Remove a previously authorized instance role (repeatable), and the instance profile setup created for it. Takes precedence over --instance-role for the same name. |
| `--revoke-sagemaker-role` |  | stringArray |  | Remove a previously authorized SageMaker execution role ARN (repeatable). Takes precedence over --sagemaker-role. |
| `--sagemaker-role` |  | stringArray |  | Authorize the hosted poller to pass this SageMaker execution role (full role ARN, repeatable) for --service sagemaker watches. A job spec naming any other RoleArn fails at submit. Every lagotto user can submit jobs with an authorized role. |

