## `lagotto deploy`

Stand up lagotto's hosted capacity poller (DynamoDB, SNS, Lambda, EventBridge
Scheduler) in your OWN AWS account, so watches are serviced server-side — armed
once, then hands-off — instead of depending on a foreground 'poll --daemon' that
dies when your laptop sleeps.

It downloads the published capacity-poller Lambda artifact for the given
--version, uploads it to a bucket in your account, and then creates or converges
the three poller resources with direct AWS API calls (#154): the SNS alerts
topic, the poller Lambda and its EventBridge schedule. Re-runs are incremental —
a --version bump is a fast code-only update — and a deploy never changes the
schedule's on/off state, so it can't switch off a running poller.

The poller schedule is created DISABLED; the first 'lagotto watch' enables it,
every 5 minutes. When no active watches or pending scheduled launches remain,
the poller slows it to once an hour (about 720 invocations a month) rather than
disabling it, and arming a watch sets it back to every 5 minutes (lagotto#323).

CloudFormation is no longer used. The template is still shipped as an optional
declarative path for IaC/enterprise consumers — see DEPLOYMENT.md. If you have an
older CloudFormation-deployed stack, this command adopts its resources
automatically (they all have fixed names) and tells you how to detach the stack
with --migrate-from-cloudformation.

Deploy also creates the poller's CloudWatch Logs log group
/aws/lambda/lagotto-capacity-poller before the function, with a 30-day retention
and the lagotto:managed=cli tag, so Lambda never creates an unowned one. A group
that already exists is tagged, and given the retention only if it has none.

Everything deploy creates is tagged spore-host:managed-by=lagotto (with
spore-host:scope, :created, :schema, :component and :owner, your aws:userid),
and resources an older lagotto created without those tags gain them. Schedules
cannot be tagged, so the poller schedule lives in the tagged EventBridge
Scheduler schedule group "lagotto", which deploy creates. A schedule an older
lagotto left in the "default" group is moved: created in "lagotto", then deleted
from "default". It stays in "default" (deploy says why) while a legacy
CloudFormation stack owns it or the IAM policies predate the group: run 'lagotto
setup' and then deploy again.

Use --teardown to delete the poller's schedule (in either group), Lambda, log
group and SNS topic in this region, then the schedule group once nothing is left
in it, and then the default artifact bucket lagotto-lambda-&lt;account&gt;-&lt;region&gt; with every object version in
it. The bucket is deleted only when this account owns it and it carries the
lagotto:managed=cli tag, which deploy writes when it creates the bucket and
back-fills on an existing default-named bucket. A --lambda-bucket you supplied
is never tagged or deleted.

```
lagotto deploy [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--environment` |  | string | `production` | Environment tag (production, staging, development) |
| `--lambda-bucket` |  | string |  | S3 bucket for the Lambda artifact (default: lagotto-lambda-&lt;account&gt;-&lt;region&gt;, created if absent) |
| `--migrate-from-cloudformation` |  | bool |  | Detach the legacy --stack-name stack from every resource it owns (retain-only change set, verify, delete) before deploying |
| `--region` |  | string |  | AWS region (default: from your AWS config) |
| `--stack-name` |  | string | `lagotto` | Legacy CloudFormation stack to detect/migrate from (the poller's own resources have fixed names) |
| `--teardown` |  | bool |  | Delete the poller, its log group, SNS topic, schedule and lagotto-managed artifact bucket instead of deploying them |
| `--version` |  | string | `dev` | lagotto release version to pull the poller Lambda from |
| `--yes` | `-y` | bool |  | Skip the confirmation prompt |

