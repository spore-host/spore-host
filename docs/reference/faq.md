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

The minimum policy is documented at [IAM Permissions](/reference/iam-permissions). In brief: EC2 describe, run, stop, terminate, tag, and create tags; IAM pass-role for the spored instance profile; Route53 for DNS registration.

---

## Instances

### What instance types are supported?

All EC2 instance types. Common choices for research:

- **General purpose**: m7i.large, m7i.xlarge
- **CPU-intensive**: c7i.2xlarge, c6i.4xlarge
- **Memory-intensive**: r7i.2xlarge, r6i.8xlarge
- **GPU (training)**: p4d.24xlarge, g5.2xlarge
- **GPU (inference)**: g5.xlarge, g4dn.xlarge
- **Free tier**: t3.micro, t2.micro

### Can I use a custom AMI?

Yes: `spawn launch --ami ami-XXXXXXXXX`. Spored is installed via user-data at launch, so it works with any Amazon Linux 2, Amazon Linux 2023, or Ubuntu AMI.

### Can I extend the TTL after launch?

Yes, at any time: `spawn extend my-instance 4h` — or from Slack: `/spore extend my-instance 4h`.

### What's the maximum TTL?

720 hours (30 days). Setting `--ttl 0` disables auto-termination, which is not recommended for anything other than long-lived development environments.

### What happens to a Spot instance when AWS interrupts it?

Spored receives the two-minute warning via the EC2 metadata service. It runs your `--pre-stop` hook if configured (for saving checkpoints), sends a Slack notification, and terminates gracefully.

---

## SSH and connectivity

### How do I connect?

```sh
spawn connect my-instance   # prints the SSH command
```

Or directly: `ssh ec2-user@<public-ip>`

### How do I find the key?

Spawn creates a key pair named `spawn-default` on first use and saves the private key to `~/.spawn/keys/spawn-default.pem`. Use it with `-i ~/.spawn/keys/spawn-default.pem` if needed.

### Why does SSH fail right after launch?

The instance takes 30–90 seconds to boot and start sshd. Wait and retry.

### Can I use my existing SSH key?

Yes: `spawn launch --key-name my-existing-keypair`

---

## Idle detection

### Why didn't my instance terminate when I expected it to?

Idle detection considers CPU, network I/O, disk I/O, GPU utilisation, active SSH sessions, and (if configured) specific process names. If any signal indicates activity, the idle timer resets. Check `spawn status my-instance` to see current activity levels.

### I'm running RStudio — why does idle detection keep resetting?

The RStudio browser tab maintains a TCP connection to the server even when you're not actively using it. Use `--active-processes rsession` to base idle detection on whether an R session process is actually running, rather than TCP connections.

### Can I disable idle detection?

Yes: `spawn launch --idle-timeout 0`. The TTL still applies as the hard outer bound.

---

## Slack / Teams

### Do I need to set up Slack to use spore.host?

No. Slack and Teams integration is optional. spore.host works fully without it — you just won't get DM notifications or slash command control.

### Can multiple people control the same instance from Slack?

Yes. Register each user separately with `spawn bot register`, granting them the actions they need. Each person can then use `/spore status`, `/spore stop`, etc. on that instance.

### Something stopped working after I updated the Slack app scopes.

Updating app scopes regenerates the signing secret. Re-register with the new secret: `spawn bot workspace-add --platform slack --workspace-id T0... --signing-secret <new-secret>`
