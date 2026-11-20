## `lagotto footprint`

List every AWS resource lagotto has in your account, say who owns each and
whether it is in use, and say whether lagotto's teardown may delete it
(lagotto#325, part of leave-no-trace spore-host/spore-host#752). Read-only: it
deletes and changes nothing. -o json emits the shared spore.host footprint
schema (libs/footprint, schema 1), which 'lagotto teardown --plan' executes.

It reads one region (--region, else your configured one) or, with
--all-regions, every region enabled for the account. In each region it lists the
three DynamoDB tables (with their record counts and whether any watch is active
or any scheduled launch armed), the artifact bucket, the alerts topic, the poller
Lambda and its log group, the schedule groups "lagotto" and "lagotto-teardown"
and their schedules, schedules named lagotto-* in the "default" group (made
before lagotto#324), the capacity reservations hold watches hold, the SageMaker
training jobs running for a watch, and the legacy CloudFormation stack
"lagotto". Account-wide it lists the poller's two IAM roles, lagotto's instance
role and its instance profiles, the instance profile 'setup' created for each
authorized instance role (and that role, which is yours), and the
lagotto-cli-user policy with how many principals it is attached to.

OWNERSHIP is "tagged" for a resource tagged spore-host:managed-by=lagotto,
"legacy-name" for one that only has lagotto's name (made before lagotto#324
tagged everything; reported, never deleted), and "foreign" for one that is not
lagotto's (an authorized instance role). A schedule cannot be tagged and carries
its group's tags.

CLASS is:
  active     in use: the tables, poller, topic and bucket of a region where a
             watch is active, a scheduled launch is armed, a hold holds a
             reservation or a training job runs (or where that could not be
             read); a per-launch schedule a scheduled-launch record names; the
             poller schedule of an active poller; anything an active resource
             depends on; lagotto-cli-user while anything is attached to it.
  residue    lagotto's own machinery, removable once nothing is active: the
             Scheduler invoke role every region shares, and a poller log group
             whose function is gone (Lambda recreated it).
  permanent  tagged spore-host:permanent=true. lagotto owns nothing permanent.
  user-data  nothing: the match history is deleted with the teardown, by owner
             decision. Export it first with 'lagotto history'.
  litter     everything else, removable now.
The account-wide resources serve every region, so they are classified only with
--all-regions; from one region they are classed active, with a warning.

DELETABLE is the shared delete guard's verdict: only a tagged resource with
lagotto's name, not tagged spore-host:role=service or spore-host:permanent=true,
whose class is not user-data or permanent. REASON says why not.

```
lagotto footprint [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--all-regions` |  | bool |  | Read every region enabled for the account (needed to classify the account-wide IAM resources); not with --region |

