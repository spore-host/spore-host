---
description: "spore.host is a set of free, open-source tools for launching ephemeral EC2 instances that manage their own lifecycle."
---

# Frequently Asked Questions

## General

### What is spore.host?

spore.host is a set of free, open-source tools for launching ephemeral EC2 instances that manage their own lifecycle. Every instance you launch gets a time-to-live and an idle detector — the TTL terminates it when the deadline passes, and idle detection stops it between tasks — so you never pay for idle compute by accident.

### What's the difference between truffle and spawn?

**Truffle** is read-only — it finds and compares instance types, Spot prices, and quotas. Think of it as search and research before you commit.

**Spawn** is the launcher — it provisions instances, installs spored, and manages the full lifecycle.

### What is spored?

Spored is a small daemon that runs on each spawned instance. It enforces the TTL, detects idle conditions, handles Spot interruptions, registers a DNS name, and sends lifecycle notifications to Slack or Teams. It runs independently of your laptop — you can close your terminal and spored keeps working.

### Is spore.host free?

Yes. The CLI tools (truffle, spawn, lagotto, spore-host-mcp) are free and open source (Apache 2.0). You pay only for the AWS resources you use — EC2 instance hours, storage, and data transfer. spore.host helps minimise these costs through TTL enforcement and idle detection.

---

## AWS and costs

### How does spore.host prevent surprise bills?

Every instance launched through spawn has a TTL — a hard deadline at which it terminates. Idle detection adds an earlier soft cutoff: if the instance has been unused for a configured period, it stops or hibernates before the TTL fires. You set both at launch time, or save them as defaults.

### Can I use spore.host with multiple AWS accounts?

Yes. Use `AWS_PROFILE=my-profile spawn launch ...` or `spawn launch --profile my-profile ...` to specify which credential profile to use per launch.

### What AWS permissions does spore.host need?

The baseline policy is documented at [IAM Permissions](/reference/iam-permissions). In brief the **core** permissions are: EC2 describe, run, stop, terminate and tag; SSM `GetParameter` to find the default AMI; and IAM create and pass-role for spawn's own instance roles. **Optional features** add their own permissions only when you use them. DNS names need none: spored registers them from the instance.

---

## Instances

### What instance types are supported?

All EC2 instance types. Common choices for research:

- **General purpose**: m7i.large, m7i.xlarge
- **CPU-intensive**: c7i.2xlarge, c6i.4xlarge
- **Memory-intensive**: r7i.2xlarge, r6i.8xlarge
- **GPU (training)**: p4d.24xlarge, g5.2xlarge
- **GPU (inference)**: g5.xlarge, g4dn.xlarge
- **Smallest / cheapest**: t3.micro, t2.micro (often Free Tier eligible, but eligibility varies by account — check the price Truffle shows)

### Can I use a custom AMI?

Yes: `spawn launch --ami ami-XXXXXXXXX`. Spored is installed via user-data at launch, so it works with any Amazon Linux 2, Amazon Linux 2023, or Ubuntu AMI.

### Can I extend the TTL after launch?

Yes, at any time: `spawn extend my-instance 4h` — or from Slack: `/spore extend my-instance 4h`.

### What's the maximum TTL?

spawn doesn't cap `--ttl`. The TTL reaper does: by default it reclaims any instance
older than 7 days, whatever its deadline, because `spawn:ttl-deadline` can be
rewritten from the instance and so can't be the only bound. spawn warns at launch
when a `--ttl` is longer than that. To keep instances longer, raise
`REAPER_MAX_AGE` on a [template-deployed reaper](/guides/reaper#covering-several-accounts);
`spawn reaper deploy` can't keep that setting today (spawn#1136).

`--ttl 0` is rejected ("must be greater than zero"). To launch without a TTL, omit
`--ttl` (with no `--idle-timeout` either, a 1h idle timeout applies) or pass
`--no-timeout`, which is not recommended for anything other than long-lived
development environments.

### What happens to a Spot instance when AWS interrupts it?

Spored receives the two-minute warning via the EC2 metadata service. It runs your `--pre-stop` hook if configured (for saving checkpoints), sends a Slack notification, and terminates gracefully.

---

## SSH and connectivity

### How do I connect?

```sh
spawn connect my-instance   # finds your key and connects; falls back to SSM
```

`spawn connect` logs you in as **your own username** — the instance creates a
Linux user matching your local login name and installs your SSH public key into
its `authorized_keys`, so you connect as you (not a generic `ec2-user`). It finds
your key automatically; if SSH isn't reachable it falls back to AWS Session
Manager. Aliased as `spawn ssh`.

### Which SSH key does spawn use?

If you have a default key — `~/.ssh/id_ed25519` (or `~/.ssh/id_rsa`) — spawn
imports **that** public key, so you connect with the key you already use. Only if
you have no default key does it generate and use a managed key under
`~/.spawn/keys/`. Point `spawn connect` at a specific key with `--key <path>`.

### Why does SSH fail right after launch?

The instance takes 30–90 seconds to boot and start sshd. Wait and retry, or use
`spawn connect` which handles the retry (and falls back to SSM).

### `spawn connect` can't reach the instance — what now?

- **No public IP / private subnet:** use SSM instead —
  `spawn connect my-instance --session-manager` (no inbound SSH needed).
- **Security group:** if you're connecting over SSH, port 22 must allow your IP.
  spawn opens it for you at launch; a later network change can break it.
- **Wrong user or key:** override with `--user <name>` / `--key <path>`. By
  default the user is your local username and the key is your default/managed key.
- **Instance stopped:** `spawn connect` auto-starts a stopped/hibernated instance
  unless you pass `--no-start`.

### Can I use my own EC2 key pair?

Yes — `spawn launch --key-name my-existing-keypair` uses an existing EC2 key pair
by name. Most users don't need this: spawn imports your local `~/.ssh` public key
automatically (see above).

---

## Idle detection

### Why didn't my instance terminate when I expected it to?

Idle detection considers CPU, network I/O, disk I/O, GPU utilisation, login sessions someone has typed in within the last 5 minutes, and (if configured) specific process names. If any signal indicates activity, the idle timer resets. Check `spawn status my-instance` to see current activity levels.

### I'm running RStudio — why does idle detection keep resetting?

It isn't the browser's open connection: spored ignores open connections, even on `--active-ports`, because an abandoned tab holds one open forever. Something is producing activity above the idle thresholds (CPU at 5% or more, network over 1 MiB/min, disk over 16 MiB/min, or a terminal someone typed in within 5 minutes). `spawn status my-instance` shows which signal is keeping it awake. If you want the instance kept up for as long as an R session runs, use `--active-processes rsession`.

### Can I disable idle detection?

Yes: `spawn launch --idle-timeout 0`. The TTL still applies as the hard outer bound.

---

## Slack / Teams

### Do I need to set up Slack to use spore.host?

No. Slack, Teams and Discord integration is optional. spore.host works fully without it — you just won't get DM notifications or slash command control.

### Can multiple people control the same instance from Slack?

Yes. Register each user separately with `spawn notify register`, granting them the actions they need. Each person can then use `/spore status`, `/spore stop`, etc. on that instance.

### Something stopped working after I updated the Slack app scopes.

Updating app scopes regenerates the signing secret. Re-register with the new secret: `spawn notify workspace add --platform slack --workspace-id T0... --bot-token xoxb-... --signing-secret <new-secret>`. `workspace add` replaces the whole workspace record, so pass the bot token again too.
