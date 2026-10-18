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
or hibernate on idle, act on a completion signal, and clean up DNS/notifications
before the instance disappears. Its rules come from the instance's EC2 tags, which
it re-reads about once a minute. See [Costs & safety guarantees](/safety) for what
happens if spored itself fails.

## What spored does

Once started, spored runs a check every minute:

1. **TTL** — if the absolute deadline (`spawn:ttl-deadline` tag) has passed, terminate.
2. **Completion signal** — if the sentinel file (`/tmp/SPAWN_COMPLETE` by default) exists, take the configured action.
3. **Cost limit** — if accumulated **compute + EBS** spend (compute rate × total compute time, carried across stop/resume, plus EBS rate × wall-clock time since launch) has exceeded `spawn:cost-limit`, terminate. FSx is not counted; `spawn launch` refuses a filesystem that alone exceeds the cap.
4. **Idle detection** — if all activity signals have been quiet for `spawn:idle-timeout`, stop (or hibernate).

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

The control-plane Lambdas you deploy yourself, such as the TTL reaper
(`spawn reaper deploy`) and lagotto's poller (`lagotto deploy`), don't upgrade
with the CLI either. `spawn reaper status` and `lagotto doctor` report when the
deployed version is behind.
:::

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
  Cost limit:       $50.00  ($1.44 compute used, 3% — $48.56 remaining; compute-only)

  CPU:              2.5%
  Network:          45 B/min
  Pre-stop hook:    aws s3 sync /results s3://bucket/run-001
```

Cost figures are estimates; definitive billing comes from AWS.

::: warning The `Cost limit` line counts compute only
The cap itself is enforced on compute **plus EBS**, but this line's "used" and
"remaining" figures still count compute alone, so it overstates the headroom —
most visibly on a stopped instance, whose EBS keeps accruing toward the cap while
the figure stands still. Add the `Storage cost` line to get closer to what the cap
sees. Tracked in [spawn#959](https://github.com/spore-host/spawn/issues/959).
:::

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
| `spawn:idle-timeout` | duration | `1h` | Stop (or hibernate) after this duration of inactivity. |
| `spawn:hibernate-on-idle` | bool | `true` | Hibernate on idle instead of stop. Default: `false`. |
| `spawn:on-complete` | enum | `terminate` | Action on completion: `terminate`, `stop`, `hibernate`. |
| `spawn:completion-file` | path | `/tmp/SPAWN_COMPLETE` | Sentinel file path to watch. Default: `/tmp/SPAWN_COMPLETE`. |
| `spawn:completion-delay` | duration | `30s` | Grace period after completion file appears. Default: `30s`. |
| `spawn:pre-stop` | shell command | `aws s3 sync /results s3://...` | Runs before any lifecycle-triggered stop/terminate. |
| `spawn:pre-stop-timeout` | duration | `5m` | Max time for the pre-stop command. Default: `5m` (Spot: `90s`). |

### Idle detection

| Tag | Type | Default | Description |
|-----|------|---------|-------------|
| `spawn:idle-cpu` | float (%) | `5.0` | CPU usage below this threshold counts as idle. |
| `spawn:active-ports` | comma-separated ints | | TCP ports to monitor — active connections prevent idle termination (e.g., `8787` for RStudio). |
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
| `spawn:notify-url` | URL | spore-bot Lambda endpoint for Slack/Teams lifecycle notifications. |
| `spawn:slack-workspace-id` | string | Workspace ID for routing notifications. |
| `spawn:dns-name` | string | DNS subdomain — spored registers on start, deregisters on shutdown. |

---

## Idle detection

Spored checks every minute. An instance is **active** (not idle) if _any_ of these are true:

| Signal | Threshold | Detail |
|--------|-----------|--------|
| SSH sessions | any | `w -h -s` — any user with keyboard activity in the last 5 minutes |
| Active processes | any running | Processes listed in `spawn:active-processes` detected via `pgrep` |
| Port connections | any | ESTABLISHED TCP connections on ports listed in `spawn:active-ports` |
| CPU usage | ≥ 5% | Measured as a delta since the last check (configurable via `spawn:idle-cpu`) |
| Network traffic | ≥ 100 KB/min | RX+TX on primary interface, measured from `/proc/net/dev` |
| Disk I/O | ≥ 100 KB/min | Read+write on block devices, measured from `/proc/diskstats` |
| GPU utilization | ≥ 5% | `nvidia-smi` — only checked if NVIDIA GPU is present |
| Active PTYs | any | Open pseudo-terminal entries in `/dev/pts/` |

The idle timer starts from the moment _all_ signals are inactive simultaneously. Any single active signal resets it.

---

## Completion file

When `--on-complete` is set at launch, spored watches for the completion file and acts when it appears.

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
1. Slack/Teams notification sent immediately
2. Users warned via `wall`
3. `spawn:completion-delay` grace period (default 30s)
4. `spawn:pre-stop` command runs (if set)
5. `spawn:on-complete` action: terminate, stop, or hibernate

---

## Lifecycle events and notifications

When `--slack-workspace` is set at launch, spored sends a DM for each event:

| Event | Trigger |
|-------|---------|
| TTL warning | 5 minutes before TTL deadline |
| TTL expired | TTL deadline reached — terminating |
| Idle warning | 5 minutes before idle timeout triggers |
| Idle stopped | Idle timeout triggered — stopping |
| Idle hibernated | Idle timeout triggered — hibernating |
| Completion | Completion file detected |
| Spot interruption | AWS 2-minute Spot reclaim notice |
| Cost limit warning | Accumulated spend ≥ 90% of `spawn:cost-limit` |

---

## Logs and diagnostics

```sh
# View daemon logs
journalctl -u spored -n 100
journalctl -u spored -f

# Raw log file
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
| `SPORED_DNS_DOMAIN` | `spore.host` | DNS domain base — change for self-hosted deployments |
