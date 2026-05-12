# Your First Instance

A complete walkthrough from a fresh install to a running EC2 instance and back. Allow 15–20 minutes.

## What you'll accomplish

- spawn and truffle installed and working
- AWS credentials verified
- An EC2 instance running in AWS
- An active SSH connection to that instance
- The instance terminated when you're done

## Prerequisites

- An AWS account (free tier works fine)
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

If this fails, run `aws configure` and enter your Access Key ID, Secret Access Key, and preferred region. spore.host uses the same credentials as the AWS CLI — nothing extra to configure.

---

## 3. Find a cheap instance

Before launching, see what's available and what it costs:

```sh
truffle find "t3 medium" --region us-east-1
```

You'll see a table with vCPUs, memory, and on-demand price. For this walkthrough we'll use a `t3.micro` — free tier eligible.

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
✓ SSH: ssh ec2-user@54.123.45.67
✓ Auto-terminates in 1h
```

spawn automatically found the latest Amazon Linux 2023 AMI, created an SSH key, configured networking, and installed spored on the instance.

---

## 5. Connect

```sh
spawn connect my-first-instance
```

This prints the SSH command. Or connect directly:

```sh
ssh ec2-user@54.123.45.67
```

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

## 7. Terminate

When you're done:

```sh
spawn terminate my-first-instance
```

Or just leave it — it auto-terminates after 1 hour.

---

## What just happened

spored was installed automatically on the instance. It runs in the background, enforces the TTL, and would detect idle activity if configured. This is the core spore.host contract: **every instance knows when to stop**.

## Next steps

- **[GPU Training Jobs](/guides/gpu-training)** — launch a GPU instance for a real workload
- **[Slack Setup](/guides/slack-setup)** — get DM notifications when your instances change state
- **[spawn launch reference](/tools/reference/spawn)** — every flag explained
