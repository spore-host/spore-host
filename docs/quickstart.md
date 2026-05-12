# Quick Start

This guide gets you from zero to a running EC2 instance in about five minutes. You'll need an AWS account with credentials configured — everything else is handled for you.

## Install

::: code-group

```sh [macOS / Linux (Homebrew)]
brew install spore-host/tap/truffle
brew install spore-host/tap/spawn
```

```powershell [Windows (Scoop)]
scoop bucket add spore-host https://github.com/spore-host/scoop-bucket
scoop install truffle spawn
```

```sh [Manual]
# Download from GitHub Releases
# https://github.com/spore-host/spore-host/releases/latest
tar -xzf spawn_*_$(uname -s)_$(uname -m).tar.gz
tar -xzf truffle_*_$(uname -s)_$(uname -m).tar.gz
```

:::

Verify the installation:

```sh
truffle --version
spawn --version
```

## Configure AWS credentials

spore.host uses your existing AWS credentials — the same ones you use for the AWS CLI. If you've already run `aws configure`, you're set.

```sh
# Check that credentials work
aws sts get-caller-identity
```

::: tip Don't have AWS CLI configured yet?
Run `aws configure` and provide your Access Key ID, Secret Access Key, and preferred region. spore.host requires permissions to describe and launch EC2 instances — see [IAM Permissions](/reference/iam-permissions) for the minimal policy.
:::

## Find an instance

Before launching, use `truffle` to find what's available and compare prices:

```sh
# Find a small instance in your region
truffle find "t3 medium"

# Find GPU instances with Spot prices
truffle find "nvidia gpu" --region us-east-1 --spot
```

You'll see a table of matching instance types with vCPUs, memory, GPU specs, on-demand price, and current Spot price. Pick a type that fits your workload and budget.

## Launch your first instance

The simplest launch uses the interactive wizard. Just run `spawn` with no arguments:

```sh
spawn
```

The wizard walks you through instance type, region, SSH key, and TTL (the duration after which the instance automatically terminates). It takes about two minutes.

For a non-interactive launch:

```sh
spawn launch \
  --name my-first-instance \
  --instance-type t3.medium \
  --ttl 4h
```

Once running, you'll see the instance ID, public IP, and SSH command:

```
✓ Instance i-0a1b2c3d4e5f running
✓ my-first-instance.abc123.spore.host
✓ SSH: ssh ec2-user@3.84.123.45
✓ Auto-terminates in 4h
```

## Connect

```sh
ssh ec2-user@<public-ip>
```

The SSH key used is whichever key you specified at launch. By default, spawn uses your `~/.ssh/id_rsa` or prompts you to select one.

## Check status

```sh
spawn list
spawn status my-first-instance
```

## Extend the TTL

If you need more time before the instance terminates:

```sh
spawn extend my-first-instance 8h
```

## Stop or terminate

```sh
spawn stop my-first-instance       # stopped, can be restarted
spawn terminate my-first-instance  # gone for good
```

## Next steps

- **[How It Works](/how-it-works)** — understand the full lifecycle and how the tools connect
- **[GPU Training](/guides/gpu-training)** — launch a GPU instance for a training job
- **[Slack Setup](/guides/slack-setup)** — control instances from Slack, get notifications when jobs finish
- **[spawn launch reference](/tools/reference/spawn)** — every flag explained
