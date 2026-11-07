## `lagotto doctor`

Report drift between the hosted capacity poller deployed in your AWS account and
what THIS lagotto binary expects. Read-only: it makes no change of any kind, and
there is no --fix.

The headline check is the poller's runtime IAM policy. 'lagotto setup' applies it
with PutRolePolicy, which REPLACES the policy wholesale with whatever grants are
compiled into the binary that ran it. So upgrading lagotto without re-running
'setup' leaves the poller on the OLD permissions — and running an OLDER lagotto's
'setup' reverts newer ones. Neither produces any signal until a watch fails, and
for the hosted poller that failure is only visible in the poller's CloudWatch
Logs. That has bitten four times (lagotto#149, #150, #151, #153).

doctor also reports a poller Lambda older than this CLI, missing tables/roles/
poller/topic/schedule, a schedule that is switched off while watches are active
(the silent-death case: nothing is polling them), and a leftover CloudFormation
stack.

It reports email delivery for --notify email: channels: an address on an active
watch whose subscription is still pending confirmation (so receives nothing yet) or
missing, a subscription no active watch needs, and any email subscription on the
alerts topic with no filter policy, which receives every user's email events.
'lagotto notify-gc' removes unused subscriptions, and with --resubscribe
subscribes missing ones.

For each active spawn or hold watch it checks default-subnet coverage
(lagotto#256): the poller launches into the default VPC with no explicit subnet,
so an AZ that offers the watch's type but has no default subnet is skipped, and
the watch can never land there. Each such AZ is a warning, with the
'aws ec2 create-default-subnet' command that fixes it.

It checks that the shared EventBridge Scheduler invoke role's policy allows
invoking THIS region's poller (lagotto#218: the role is IAM-global, and a deploy
by lagotto older than v0.65.1 scoped it to the deploying region alone, so every
other region's schedule failed silently). The policy is evaluated locally.

It lists every lagotto-lambda-&lt;account&gt;-&lt;region&gt; artifact bucket in the account
(lagotto#264) and warns about each one in a region with no poller, an orphan a
'deploy --teardown' from before #264 left behind, with the command that deletes
it. That needs s3:ListAllMyBuckets; without it the check is a warning.

It checks YOUR credentials (lagotto#232): the IAM policy simulator
(iam:SimulatePrincipalPolicy) is asked whether the identity running doctor may
call every action, on every resource, of the lagotto-cli-user policy 'lagotto
setup' writes, and it lists what is denied with the command that attaches the
policy. An assumed role is simulated as its IAM role, not the STS session. When
the simulation cannot be made (no iam:SimulatePrincipalPolicy, the root user)
the result is reported as unknown. Every outcome is a warning at most: the
simulator is a model (it ignores session policies), so a denial is a lead.

Best effort, it also reports EventBridge Scheduler target errors in the last 24h
(CloudWatch AWS/Scheduler TargetErrorCount for the poller's schedule group). That
needs cloudwatch:GetMetricStatistics on your credentials; without it the check
is a warning, never a failure.

Exit code is non-zero if any check FAILS, so it can gate CI. Warnings do not
affect it. Use -o json for the machine-readable form, including the exact
missing/extra IAM grants.

```
lagotto doctor [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--stack-name` |  | string | `lagotto` | Legacy CloudFormation stack to look for (same meaning as on 'lagotto deploy') |

