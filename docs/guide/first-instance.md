# Launch Your First Instance

A complete end-to-end walkthrough from setup to a running EC2 instance.

## What You'll Accomplish

By the end of this guide you will have:
- spawn installed and configured
- AWS credentials working
- An EC2 instance running in AWS
- An active SSH connection to that instance

Estimated time: 15-20 minutes

## Prerequisites

- An AWS account (free-tier works)
- macOS or Linux terminal (Windows: use WSL2)
- Basic comfort with command-line tools

---

## Step 1: Install spawn

### macOS

```bash
brew tap spore-host/tap
brew install spawn
```

### Linux

```bash
curl -Lo spawn https://github.com/spore-host/spore-host/releases/latest/download/spawn-linux-amd64
chmod +x spawn
sudo mv spawn /usr/local/bin/
```

Verify:

```bash
spawn --version
# spawn version 0.23.0
```

If this fails, see [Installation](../user-guide/installation.md).

---

## Step 2: Configure AWS Credentials

If you already have `aws configure` set up, skip to Step 3.

```bash
aws configure
```

Enter:
- **AWS Access Key ID**: Your IAM access key
- **AWS Secret Access Key**: Your IAM secret key
- **Default region name**: `us-east-1` (or your preferred region)
- **Default output format**: `json`

Verify credentials work:
```bash
aws sts get-caller-identity
```

Expected output:
```json
{
    "UserId": "AIDAIOSFODNN7EXAMPLE",
    "Account": "123456789012",
    "Arn": "arn:aws:iam::123456789012:user/myuser"
}
```

If this fails, see [Authentication](../user-guide/authentication.md).

---

## Step 3: Launch Your First Instance

```bash
spawn launch --ttl 1h --name my-first-instance
```

Watch the output:

```
Resolving AMI...       ✓ ami-0c55b159cbfafe1f0 (Amazon Linux 2023)
Creating SSH key...    ✓ spawn-default (saved to ~/.spawn/keys/spawn-default.pem)
Creating security group... ✓ sg-0a1b2c3d4e5f67890
Launching instance...  ✓ i-0123456789abcdef0
Registering DNS...     ✓ my-first-instance.spore.host (propagating...)
Installing spored...   ✓ agent starting

Instance ready!
  Name:   my-first-instance
  Type:   t3.micro
  Region: us-east-1
  IP:     54.123.45.67
  DNS:    my-first-instance.spore.host
  TTL:    1h (expires at 15:30 UTC)
  Cost:   ~$0.0104/hr
```

This takes 60-90 seconds.

### What Just Happened?

spawn automatically:
1. Found the latest Amazon Linux 2023 AMI for `us-east-1`
2. Created an SSH key pair (`spawn-default`) and saved it locally
3. Created a security group allowing SSH from anywhere
4. Launched a `t3.micro` instance with a 1-hour TTL
5. Installed the spored monitoring agent via user-data
6. Registered `my-first-instance.spore.host` in Route53

---

## Step 4: Connect via SSH

Wait 60 seconds for the instance to fully boot, then:

```bash
spawn ssh my-first-instance
```

Or directly:
```bash
ssh ec2-user@my-first-instance.spore.host
```

You should see:
```
   __|  __|  __|
   _|  (   \__ \   Amazon Linux 2023
 ____|\___|____/

[ec2-user@ip-10-0-1-42 ~]$
```

You're connected!

---

## Step 5: Run Something

```bash
# Check system info
uname -a
cat /etc/os-release

# Check spored is running
sudo systemctl status spored

# Run a quick benchmark
time openssl speed aes-256-cbc
```

---

## Step 6: Check TTL Status

From your local machine (in another terminal):

```bash
truffle get my-first-instance
```

Output shows remaining TTL, CPU usage, and status.

---

## Step 7: Terminate

When done, terminate immediately:

```bash
spawn terminate my-first-instance
```

Or leave it — it will auto-terminate after 1 hour.

---

## What's Next?

- [SSH Access](../user-guide/ssh-access.md) — port forwarding, file transfer, tmux
- [Configuration](../user-guide/configuration.md) — set defaults for instance type and TTL
- [Parameter Sweep Walkthrough](parameter-sweep-walkthrough.md) — run parallel jobs
- [Spot Instances](../features/spot-instances.md) — save 70% on batch workloads
