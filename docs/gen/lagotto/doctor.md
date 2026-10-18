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

