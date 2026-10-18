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

The poller schedule is created DISABLED; the first 'lagotto watch' enables it
(and the poller self-disables when no active watches remain).

CloudFormation is no longer used. The template is still shipped as an optional
declarative path for IaC/enterprise consumers — see DEPLOYMENT.md. If you have an
older CloudFormation-deployed stack, this command adopts its resources
automatically (they all have fixed names) and tells you how to detach the stack
with --migrate-from-cloudformation.

Use --teardown to delete the poller, topic and schedule.

```
lagotto deploy [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--environment` |  | string | `production` | Environment tag (production, staging, development) |
| `--lambda-bucket` |  | string |  | S3 bucket for the Lambda artifact (default: lagotto-lambda-&lt;account&gt;-&lt;region&gt;, created if absent) |
| `--migrate-from-cloudformation` |  | bool |  | Detach the legacy --stack-name stack from the poller resources (retain-update, verify, delete) before deploying |
| `--region` |  | string |  | AWS region (default: from your AWS config) |
| `--stack-name` |  | string | `lagotto` | Legacy CloudFormation stack to detect/migrate from (the poller's own resources have fixed names) |
| `--teardown` |  | bool |  | Delete the poller, SNS topic and schedule instead of deploying them |
| `--version` |  | string | `dev` | lagotto release version to pull the poller Lambda from |
| `--yes` | `-y` | bool |  | Skip the confirmation prompt |

