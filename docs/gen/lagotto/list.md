## `lagotto list`

List your watches.

Besides each watch's definition, the table shows its heartbeat:

  LAST POLL  how long ago the poller last checked it ("4m", "2h"). An active
             watch is flagged "!" when that is over 15 minutes: the poller is
             disabled or failing, or its capacity search keeps failing.
  TRIES      how many launch/hold/notify attempts it has made.
  GROUP      the watch group it belongs to (lagotto watch --group): the
             first member to land cancels the others. "lagotto status
             &lt;group&gt;" shows the whole group.
  LAST ERR   the class of its latest error: capacity, quota, terminal,
             unknown, or search (the capacity search itself failed).

EXPOSURE is what the watch can cost if it lands: "≤$X/hr" for spawn (a
fleet's total), "30m@$X/hr" for a hold's reservation (billed even if unused),
"none" for notify, "unknown" when lagotto has no price. "cap" means it is your
--max-price, "*" a rate from the static price list (the note under the table
says when it was collected and why), "?" that some types or regions have no
price. The CLI never calls the live Price List.

Below the table, it lists every active spawn watch whose stored spawn config
the hosted poller will refuse when the watch matches, with the fix: one armed
with iam_policy, iam_policy_file or iam_policy_document (refused since 0.70.0),
or one whose iam_role the deployed poller is not authorized to use. -o json
carries it as launch_config_problem.

Use -o wide for the full latest error, or -o json for every field.
"lagotto status &lt;watch-id&gt;" shows the full errors and when they happened.

```
lagotto list [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--all` |  | bool |  | Show all statuses, including expired, cancelled, completed and failed watches (default: active only) |
| `--mine` |  | bool |  | Only show watches you created (matches your caller ARN) |
| `--project` |  | string |  | Only show watches with this project label |

