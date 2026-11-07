## `lagotto list`

List your watches.

Besides each watch's definition, the table shows its heartbeat:

  LAST POLL  how long ago the poller last checked it ("4m", "2h"). An active
             watch is flagged "!" when that is over 15 minutes: the poller is
             disabled or failing, or its capacity search keeps failing.
  TRIES      how many launch/hold/notify attempts it has made.
  LAST ERR   the class of its latest error: capacity, quota, terminal,
             unknown, or search (the capacity search itself failed).

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

