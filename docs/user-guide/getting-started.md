# Getting Started

This guide walks you through launching your first EC2 instance with spawn. Estimated time: 15 minutes.

## Prerequisites

- AWS account with programmatic access
- macOS or Linux (Windows via WSL2)
- Basic command-line familiarity

## Step 1: Install spawn

**macOS (Homebrew):**
```bash
brew tap spore-host/tap
brew install spawn
```

**Linux (pre-built binary):**
```bash
curl -Lo spawn https://github.com/spore-host/spore-host/releases/latest/download/spawn-linux-amd64
chmod +x spawn
sudo mv spawn /usr/local/bin/
```

Verify: `spawn --version`

## Step 2: Configure AWS Credentials

spawn uses standard AWS credential resolution. The simplest approach:

```bash
aws configure
# AWS Access Key ID: AKIAIOSFODNN7EXAMPLE
# AWS Secret Access Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
# Default region: us-east-1
# Default output format: json
```

Or use an IAM role with an EC2 instance profile if running spawn from EC2.

Minimum IAM permissions required: see [Authentication](authentication.md#minimum-iam-permissions).

## Step 3: Launch Your First Instance

```bash
spawn launch --ttl 1h
```

spawn automatically:
- Selects the latest Amazon Linux 2023 AMI
- Creates an SSH key pair if none exists
- Configures security groups for SSH access
- Installs the spored monitoring agent
- Registers a DNS name (e.g., `myinstance.spore.host`)

Output:
```
Launched: my-instance-abc123
Type:     t3.micro
Region:   us-east-1
IP:       54.123.45.67
DNS:      my-instance-abc123.spore.host
TTL:      1h (terminates at 14:30 UTC)
Cost:     ~$0.01/hour
```

## Step 4: Connect via SSH

```bash
spawn ssh my-instance-abc123
# or
ssh my-instance-abc123.spore.host
```

## Step 5: Extend or Terminate

```bash
# Extend TTL by 30 minutes
spawn extend my-instance-abc123 30m

# Terminate immediately
spawn terminate my-instance-abc123
```

The instance also terminates automatically when the TTL expires.

## What Happens After Launch

The spored agent on your instance:
- Monitors CPU, memory, and network for idle detection
- Enforces TTL (warns you 10 minutes before expiry)
- Handles spot interruption gracefully
- Registers and updates DNS

You do **not** need to keep your laptop running — spored manages the lifecycle independently.

## Next Steps

- [Installation](installation.md) — all install options
- [Configuration](configuration.md) — customize defaults
- [CLI Reference](cli-reference.md) — full command reference
- [Dashboard](dashboard.md) — monitor instances in the browser
