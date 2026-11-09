---
description: "A complete walkthrough from a fresh install to a running EC2 instance and back."
---

# Your First Instance

A complete walkthrough from a fresh install to a running EC2 instance and back. Allow 15–20 minutes.

## What you'll accomplish

- spawn and truffle installed and working
- AWS credentials verified
- An EC2 instance running in AWS
- An active SSH connection to that instance
- The instance terminated when you're done

## Prerequisites

- An AWS account (a small instance costs a few cents for this walkthrough)
- macOS, Linux, or Windows with WSL2
- Basic comfort with the command line

---

## 1. Install

```sh
brew install spore-host/tap/truffle
brew install spore-host/tap/spawn
```

Verify:

```sh
truffle --version
spawn --version
```

If you're not on macOS or need a different install method, see the [Installation guide](/guides/installation).

---

## 2. Check your AWS credentials

```sh
aws sts get-caller-identity
```

Expected output:

```json
{
    "UserId": "AIDAIOSFODNN7EXAMPLE",
    "Account": "123456789012",
    "Arn": "arn:aws:iam::123456789012:user/yourname"
}
```

If this fails, sign in with **`aws login`** (AWS CLI v2.32.0+; static `aws configure` keys also work). spore.host uses the same credentials as the AWS CLI — nothing extra to configure. See [AWS Authentication](/guides/aws-auth) for profiles and how auth relates to permissions.

---

## 3. Find a cheap instance

Before launching, see what's available and what it costs:

```sh
truffle find "t3 medium" --region us-east-1
```

You'll see a table with vCPUs, memory, and on-demand price. For this walkthrough we'll use a `t3.micro` — cheap, and marked Free Tier eligible in many accounts (eligibility and credits vary by account age/plan, so check the price Truffle shows before launching).

---

## 4. Launch

```sh
spawn launch \
  --name my-first-instance \
  --instance-type t3.micro \
  --ttl 1h
```

After about 60–90 seconds:

```
✓ Instance i-0a1b2c3d4e5f running
✓ my-first-instance.abc123.spore.host
✓ Connect: spawn connect my-first-instance
✓ Auto-terminates in 1h
```

spawn automatically found the latest Amazon Linux 2023 AMI, imported your existing SSH public key (or generated a managed one if you had none), created a Linux user matching your local login, configured networking, and installed spored on the instance.

---

## 5. Connect

```sh
spawn connect my-first-instance
```

This logs you in **as your own username** (the Linux user spawn created to match
your local login), using the key it imported — you don't need to know the address,
key path, or username. Raw `ssh <you>@<public-ip>` works too if you prefer.

::: tip
If you get "Connection refused", the instance is still booting. Wait 30 seconds and try again.
:::

Once connected, confirm spored is running:

```sh
sudo systemctl status spored
```

---

## 6. Check status from your laptop

In a second terminal:

```sh
spawn status my-first-instance
```

This shows state, IP, type, uptime, and time remaining before auto-termination.

---

## Verify lifecycle protection

Before you rely on auto-termination, confirm the instance is actually protecting itself. Two quick checks:

```sh
spawn status my-first-instance        # from your laptop
```

The output shows **time remaining before auto-termination** — if you see a TTL countdown, spawn tagged the instance correctly and the deadline is live. On the instance itself:

```sh
sudo systemctl status spored          # over SSH
```

`active (running)` means the daemon that enforces the deadline is up. spored reads its rules from the instance's EC2 tags every minute, so the TTL holds even if you close your laptop.

For what happens if any of this *fails* — a missing instance profile, a crashed daemon, changed tags — and the out-of-band backstop that catches it, see [Costs & safety guarantees](/safety).

---

## Clean up

When you're done, permanently terminate it (destroys the instance and its EBS volume):

```sh
spawn terminate my-first-instance       # confirms first; add -y to skip
```

Or `spawn stop my-first-instance` to keep the EBS volume and resume later (the volume still bills until you terminate) — or just leave it, since it auto-terminates at the **1-hour TTL you set** with `--ttl 1h`. (TTL is a hard deadline that *terminates*; idle timeout is a separate, opt-in setting that *stops*.)

---

## What just happened

spored was installed automatically on the instance. It runs in the background, enforces the TTL, and would detect idle activity if configured. This is the core spore.host contract: **every instance knows when to stop**.

## Next steps

- **[Worked transcripts](/guides/transcripts)** — complete terminal output for this flow, including a blocked preflight
- **[GPU Training Jobs](/guides/gpu-training)** — launch a GPU instance for a real workload
- **[Lifecycle Notifications](/guides/notifications)** — see TTL, idle, completion and Spot events, and get completion/Spot notices on your own webhook
- **[spawn launch reference](/tools/reference/spawn)** — every flag explained
