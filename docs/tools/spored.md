---
description: "Spored is the lifecycle daemon that runs on every instance launched by spawn."
---

# Spored <span class="doc-badge stable">Stable</span>

**What it is.** Spored is the lifecycle daemon that runs on every instance launched
by spawn. It's a small binary provisioned automatically at launch — **you never
install or run it manually**.

**When you meet it.** You don't invoke spored from your laptop; spawn provisions it
and it works on its own. You only interact with it directly when debugging *on* an
instance (`sudo systemctl status spored`, `spored status`, `spored complete`).

**Why it matters.** It's the reason auto-termination survives your laptop closing:
spored enforces the lifecycle from *inside* the instance — terminate on TTL, stop
or hibernate on idle (or terminate, for instances with nothing to come back to),
act on a completion signal, and clean up DNS/notifications
before the instance disappears. Its rules come from the instance's EC2 tags, which
it re-reads about once a minute. See [Costs & safety guarantees](/safety) for what
happens if spored itself fails.

## What spored does

Once started, spored runs a check every minute:

1. **TTL** — if the absolute deadline (`spawn:ttl-deadline` tag) has passed, terminate.
2. **Completion signal** — if the sentinel file (`/tmp/SPAWN_COMPLETE` by default) exists, take the configured action. If the file appears before the `spawn:on-complete` tag is readable (EC2 tags are eventually consistent), spored re-reads the tags on that tick instead of waiting for its next scheduled refresh, up to 5 times per instance (since v0.136.0).
3. **Cost limit** — if accumulated **compute + EBS** spend (compute rate × total compute time, carried across stop/resume, plus EBS rate × wall-clock time since launch) has exceeded `spawn:cost-limit`, terminate. FSx is not counted; `spawn launch` refuses a filesystem that alone exceeds the cap.
4. **Idle detection** — if all activity signals have been quiet for `spawn:idle-timeout`, stop (or hibernate). With `spawn:terminate-on-idle=true`, terminate instead: spawn sets that on `spawn service` instances, pool workers and `spawn burst` members (since v0.136.0).

Every tick spored also writes the `spawn:last-heartbeat` tag (at most once a
minute). `spawn launch` waits for that tag to confirm spored came up, and the
[TTL reaper](/guides/reaper) reports instances whose heartbeat has gone stale.

Spot interruption notices are polled separately every 5 seconds and acted on immediately.

## Versioning

spored is built and released with spawn: the same version tag and the same
release run. Every spawn release publishes spored (Linux `amd64`/`arm64` and
Windows `amd64`), signed, to regional S3 buckets.

::: warning An instance runs the **latest** spored, not your CLI's
At boot, an instance downloads whichever spored is newest in its region's
bucket, **whatever version of spawn launched it**. So:

- an old `spawn` CLI still gets the current spored on every new instance;
- a running instance keeps the spored it booted with until you upgrade it
  (`spawn upgrade-spored <instance>`, Linux only for now);
- `spored version` on an instance reports the spored it's running, which may
  differ from your `spawn version`.

Behaviour that's new in a spored release, such as idle termination
(`spawn:terminate-on-idle`, v0.136.0), reaches only instances running that spored
or later. An older spored ignores the tag and stops the instance.

The control-plane Lambdas you deploy yourself, such as the TTL reaper
(`spawn reaper deploy`) and lagotto's poller (`lagotto deploy`), don't upgrade
with the CLI either. `spawn reaper status` and `lagotto doctor` report when the
deployed version is behind.
:::

## How it's installed, and how spawn knows it's running

The instance's user data downloads spored, checks its checksum **and** its
signature against the spore.host signing key, and installs nothing if either
check fails. Since v0.135.2 the installer also works on:

- **Rocky Linux 8 and RHEL 8**, whose curl (7.61) is older than the options the
  installer used to pass. Before, every download failed there and the instance
  ran with no spored.
- **SELinux-enforcing AMIs such as Rocky Linux 9.** The installer runs
  `restorecon` on the binary and its systemd unit, so systemd may start it.
  Before, spored failed with `status=203/EXEC` on every restart. Nothing changes
  on hosts without SELinux or with it disabled.

After launching, `spawn launch` waits for spored's first `spawn:last-heartbeat`
tag (up to 5 minutes on Linux, 10 on Windows). It asks SSM as well, which can
answer first, but an AMI without `amazon-ssm-agent` (official Rocky and RHEL
images) no longer fails verification (since v0.136.0). If neither signal
arrives, the launch exits 1 with "spored never came up" and says which evidence
was missing; see [Troubleshooting](/reference/troubleshooting#spored-never-came-up).
`--wait-for-ssh=false` skips the check and says spored wasn't verified; with
`-o json`, `spored_verified` is `false`.

## Subcommands

Spored is invoked directly on the instance (not from your laptop):

```
spored                  Run as daemon (systemd starts this automatically)
spored status           Show lifecycle state, TTL, cost, and metrics
spored reload           Re-read EC2 tags without restarting the daemon
spored config get <key> Query a single configuration value
spored config set <key> <value>  Update a tag and reload
spored config list      Show all configuration
spored complete         Signal that your workload finished
spored version          Print version
```

### `spored status`

Shows the current lifecycle state of the instance:

```
  my-job  (i-0abc123def456xyz)
  ──────────────────────────────────────────────

  Started:          2026-05-18 10:00 UTC
  Elapsed:          6h 30m (5h compute · 1h 30m stopped)
  TTL:              2h 30m remaining  (terminates 2026-05-18 19:00 UTC)
  Idle timeout:     1h  (currently active)
  On complete:      terminate (watching /tmp/SPAWN_COMPLETE)

  Compute cost:     $1.44  (5h × $0.2400/hr)
  Storage cost:     $0.18  (1h 30m × $0.1200/hr EBS)
  Cumulative cost:  $1.62
  Effective rate:   $0.2496/hr  (4% lower than continuous on-demand)
  Cost limit:       $50.00  ($1.62 used, compute + EBS, 3% — $48.38 remaining)

  CPU:              2.5%
  Network:          45 B/min
  Pre-stop hook:    aws s3 sync /results s3://bucket/run-001
```

Cost figures are estimates; definitive billing comes from AWS.

The `Cost limit` line counts compute **plus EBS**, the same spend the cap is
enforced against, so its "remaining" figure is the real headroom (since v0.129.0).

### `spored config get/set/list`

Read or update lifecycle settings without SSH-ing in — `spawn instance-config` calls these via SSH from your laptop. You can also call them directly on the instance:

```sh
spored config list
spored config get idle-timeout
spored config set ttl 12h
spored config set on-complete stop
```

Valid keys: `ttl`, `idle-timeout`, `on-complete`, `hibernate`, `completion-file`, `completion-delay`

`set` updates the corresponding EC2 tag and calls `spored reload`.

### `spored complete`

Signal that your workload finished. Writes the completion file to trigger the `spawn:on-complete` action.

```sh
spored complete                                     # empty file
spored complete --status success
spored complete --status success --message "1000 jobs done"
spored complete --file /var/run/myapp/done          # custom path
```

After the file appears, spored waits `spawn:completion-delay` (default 30s), then takes the `spawn:on-complete` action: `terminate`, `stop`, or `hibernate`.

---

## EC2 tags reference

All spored configuration is stored as EC2 tags. Spawn writes them at launch; you can read them with `spored config list` and update writable ones with `spored config set` or directly via the EC2 API.

### Lifecycle

| Tag | Type | Example | Notes |
|-----|------|---------|-------|
| `spawn:ttl` | duration | `24h` | Maximum lifetime from launch. |
| `spawn:ttl-deadline` | RFC3339 | `2026-05-19T14:00:00Z` | **Authoritative deadline** — set once at launch, never resets across stop/wake cycles. Takes precedence over `spawn:ttl`. |
| `spawn:launch-time` | RFC3339 | `2026-05-18T10:00:00Z` | Original launch time, anchors the deadline. |
| `spawn:idle-timeout` | duration | `1h` | Stop (or hibernate, or terminate with `spawn:terminate-on-idle`) after this duration of inactivity. |
| `spawn:hibernate-on-idle` | bool | `true` | Hibernate on idle instead of stop (set by `--on-idle hibernate`). Default: `false`. |
| `spawn:terminate-on-idle` | bool | `true` | Terminate on idle instead of stopping. Wins over `spawn:hibernate-on-idle`. Set by `spawn service`, `spawn pool` and `spawn burst`; there's no launch flag. Default: `false`. |
| `spawn:on-complete` | enum | `terminate` | Action on completion: `terminate`, `stop`, `hibernate`. |
| `spawn:completion-file` | path | `/tmp/SPAWN_COMPLETE` | Sentinel file path to watch. Default: `/tmp/SPAWN_COMPLETE`. |
| `spawn:completion-delay` | duration | `30s` | Grace period after completion file appears. Default: `30s`. |
| `spawn:pre-stop` | shell command | `aws s3 sync /results s3://...` | Runs before any lifecycle-triggered stop/terminate. |
| `spawn:pre-stop-timeout` | duration | `5m` | Max time for the pre-stop command. Default: `5m` (Spot: `90s`). |

### Idle detection

| Tag | Type | Default | Description |
|-----|------|---------|-------------|
| `spawn:idle-cpu` | float (%) | `5.0` | CPU usage below this threshold counts as idle. There is no launch flag; set the tag to change it. |
| `spawn:active-ports` | comma-separated ints | | TCP ports whose ESTABLISHED connections are counted and reported in the `spawn:logged-in-count` tag. They do **not** prevent idle: an abandoned browser tab holds a connection open forever. Use `spawn:active-processes` to keep a busy app alive. |
| `spawn:active-processes` | comma-separated strings | | Process names to check via `pgrep` — if any are running, not idle (e.g., `rsession,jupyter`). |

### Cost tracking

| Tag | Type | Description |
|-----|------|-------------|
| `spawn:price-per-hour` | float | On-demand hourly rate — written at launch for cost display. |
| `spawn:ebs-hourly-cost` | float | EBS volume cost/hr — looked up once by spored on first start and cached here. |
| `spawn:compute-seconds` | int | Cumulative compute seconds — updated by spored every few minutes. |
| `spawn:cost-limit` | float | Terminate when total **compute + EBS** spend reaches this amount (USD). Compute accumulates across stop/resume; EBS accrues on wall-clock time, including while stopped. FSx/EFS are not counted. |

### Notifications and DNS

| Tag | Type | Description |
|-----|------|-------------|
| `spawn:notify-url` | URL | spore-bot Lambda endpoint spored posts lifecycle events to (Slack, Teams or Discord). |
| `spawn:slack-workspace-id` | string | Workspace ID for routing notifications. |
| `spawn:notify-platform` | string | `slack` (default when absent), `teams` or `discord`, from `--notify-platform`. |
| `spawn:dns-name` | string | DNS label (not a full hostname). spored registers `<label>.<account-base36>.<domain>` on start and removes it on shutdown. |
| `spawn:dns-domain` | string | Zone to register under, when not `spore.host` (`--dns-domain`). |
| `spawn:dns-endpoint` | URL | Custom DNS updater endpoint (`--dns-api-endpoint`). |

---

## Idle detection

Spored checks every minute. An instance is **active** (not idle) if _any_ of these are true:

| Signal | Threshold | Detail |
|--------|-----------|--------|
| Login sessions | any typing in the last 5 minutes | A terminal counts only while someone types in it (its last input is under 5 minutes old). An open SSH session, tmux/screen session or SSM shell that nobody is using does not count. |
| Active processes | any running | Processes listed in `spawn:active-processes` |
| CPU usage | ≥ 5% | Measured as a delta since the last check (configurable via `spawn:idle-cpu`) |
| Network traffic | > 1 MiB/min | RX+TX, measured from `/proc/net/dev` |
| Disk I/O | > 16 MiB/min | Read+write on block devices, measured from `/proc/diskstats` |
| GPU / accelerator utilization | > 5% | `nvidia-smi` (and the Neuron/Gaudi equivalents), only when such a device is present |

A signal that can't be measured counts as active, so "couldn't tell" never reads as
idle. Connections on `spawn:active-ports` are counted and reported, but they do
**not** keep the instance active.

The idle timer starts from the moment _all_ signals are inactive simultaneously. Any single active signal resets it.

---

## Completion file

When `--on-complete` is set at launch, spored watches for the completion file and acts when it appears.

A `--command` writes this file itself when it exits, pass or fail (its exit code
goes to `/tmp/SPAWN_EXITCODE`), so you only need to create it for work you start
some other way.

**Default path:** `/tmp/SPAWN_COMPLETE`

**Creating it from your job script:**

```sh
# Option 1: empty file
touch /tmp/SPAWN_COMPLETE

# Option 2: with metadata (recommended)
spored complete --status success --message "Finished 1000 parameter combinations"

# Option 3: custom path (must match --completion-file at launch)
spored complete --file /var/run/myapp/done
```

**File format:** optional JSON metadata — spored reads and logs it, then acts regardless of content:

```json
{
  "status": "success",
  "message": "All tasks done",
  "timestamp": "2026-05-18T14:30:00Z"
}
```

**Sequence after file appears:**
1. spored notices the file at its next check (it checks once a minute)
2. `completion` notification sent (Slack, Teams or Discord)
3. Users warned via `wall`
4. `spawn:completion-delay` grace period (default 30s)
5. `spawn:pre-stop` command runs (if set), then DNS and plugin cleanup
6. Users warned again, and 5 seconds later the `spawn:on-complete` action: terminate, stop, or hibernate

### How long after the command exits does the instance terminate?

spored does not watch the process. It polls for the completion file on a
one-minute ticker, so the wait starts when the file appears, not when your
command's last line is printed. A `--command` writes the file as soon as the
command and its output pipe have closed: a background process that still holds
the command's output delays it
([spawn#1459](https://github.com/spore-host/spawn/issues/1459)).

From the completion file to the terminate call (spored v0.153.0 and later):

| Step | Time |
|---|---|
| Ticker phase: the file waits for spored's next check | 0–60 s |
| `--completion-delay` | 30 s by default |
| `spawn:pre-stop` hook | 0 s if unset; up to `spawn:pre-stop-timeout` (5 min by default) |
| Task-record flush, DNS and plugin cleanup | usually under a few seconds; each cleanup step is capped at 10 s |
| Warning to logged-in users | 5 s |

With the defaults and no pre-stop hook that is **about 35–95 s**. EC2 shows the
instance `shutting-down` within seconds of the call. TTL, cost-limit and idle
terminations skip the completion delay: 0–60 s from the deadline to spored's
check, then the pre-stop hook, the cleanup and the 5 s warning.

Before v0.153.0, the last spawn-managed instance in a region waited another
60 s before terminating, for the `region_vacated` check, whether or not a
notifier was configured: **about 95–155 s** with the defaults. That check now
runs only when notifications are enabled, and its settle window is the waits
above, so it adds nothing
([spawn#1456](https://github.com/spore-host/spawn/issues/1456)). An instance
launched by an older CLI keeps its old spored until `spawn upgrade-spored`.

---

## Lifecycle events and notifications

When `--slack-workspace` is set at launch, spored posts each event to the
spore-bot Lambda (`spawn:notify-url`), which sends it to the users registered for
the instance on Slack, Teams or Discord (`--notify-platform`). The event names
are:

| Event | Trigger |
|-------|---------|
| `ttl_warning` | 5 minutes before the TTL deadline |
| `ttl_expired` | TTL deadline reached — terminating |
| `idle_warning` | 5 minutes before the idle timeout triggers |
| `idle_stopped` | Idle timeout triggered and the stop was accepted |
| `idle_hibernated` | Idle timeout triggered and the hibernate was accepted |
| `idle_stop_failed` | The idle stop or hibernate failed; the instance is still running and spored retries with backoff |
| `completion` | Completion file detected |
| `completion_stop_failed` | The on-complete stop or hibernate failed; spored retries with backoff |
| `pre_stop_start` | The pre-stop hook begins |
| `pre_stop_timeout` | The pre-stop hook ran past `spawn:pre-stop-timeout` |
| `pre_stop_failed` | The pre-stop hook exited with an error |
| `spot_interrupt` | AWS 2-minute Spot reclaim notice |
| `spot_replacement_retired` | A replacement EC2 launched from a leaked Spot request was found; spored cancels the request and terminates the replacement. Sent to the original instance's users. |
| `fsx_mount_failed` | The FSx filesystem could not be mounted |
| `fsx_dra_failed` | The FSx data repository association (S3 link) could not be set up |
| `region_vacated` | No other spawn-managed instance was running or pending in the region when this one's termination was decided, nor when it terminated |

An idle **termination** (`spawn:terminate-on-idle`) sends no chat event yet
([spawn#1205](https://github.com/spore-host/spawn/issues/1205)). Users logged in
to the instance still get spored's terminate warning.

The cost-limit warning is not a chat notification. At 90% of `spawn:cost-limit`,
spored broadcasts a warning to logged-in users with `wall` and writes it to
`/tmp/SPAWN_WARNING`. The TTL and idle warnings are sent the same way too, in
addition to the chat event.

---

## Logs and diagnostics

spored writes its log to `/var/log/spored.log` (`%PROGRAMDATA%` on Windows),
not to the journal, so `journalctl -u spored` shows nothing from spored
itself. From your machine, `spawn logs <name> --which spored` reads it.

```sh
# From your machine
spawn logs my-job --which spored

# On the instance
tail -f /var/log/spored.log

# Full status with cost breakdown
spored status

# Check what tags spored is reading
aws ec2 describe-tags \
  --filters "Name=resource-id,Values=$(ec2-metadata --instance-id | cut -d' ' -f2)" \
  --query 'Tags[?starts_with(Key, `spawn:`)].{K:Key,V:Value}' \
  --output table
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SPORED_TAG_PREFIX` | `spawn` | EC2 tag prefix — change this for multi-tenant deployments |
| `SPORED_DNS_DOMAIN` | `spore.host` | DNS domain, used only when the instance has no `spawn:dns-domain` tag. The tag (`--dns-domain` at launch) is the normal way to set it. |
