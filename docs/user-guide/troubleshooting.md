# Troubleshooting

## Launch Failures

### `ValidationError: Image ID ... does not exist`

The AMI is not available in your region. spawn selects the latest Amazon Linux 2023 AMI per-region.

Fix: Specify a region-specific AMI:
```bash
# List available AMIs in your region
aws ec2 describe-images --owners amazon --filters "Name=name,Values=al2023-ami-*" --query 'Images[0].ImageId'

spawn launch --ami ami-XXXXXXXXX
```

### `UnauthorizedOperation` or `AccessDenied`

Your IAM credentials lack the required permissions.

Fix: Check that your IAM user/role has the minimum permissions. See [Authentication](authentication.md#minimum-iam-permissions).

Quick check:
```bash
aws sts get-caller-identity
aws ec2 describe-instances --max-results 5
```

### `InsufficientInstanceCapacity`

AWS doesn't have available capacity for that instance type in that availability zone.

Fix:
```bash
# Try a different AZ
spawn launch --instance-type c7i.large --subnet-id subnet-OTHER

# Use spot instances (higher availability)
spawn launch --instance-type c7i.large --spot

# Try adjacent instance type
spawn launch --instance-type c7i.xlarge
```

### Instance Stuck in `pending` State

If an instance stays pending for >5 minutes, the user-data (startup) script may have failed.

Fix:
```bash
# Check instance system log
aws ec2 get-console-output --instance-id i-XXXXXXXXX

# View spored startup logs after SSH
spawn ssh my-instance
sudo journalctl -u spored -n 50
```

## SSH Connection Issues

### `Connection refused`

Instance is still starting. Wait 60-90 seconds after launch.

```bash
# Check instance state
truffle get my-instance
```

### `Permission denied (publickey)`

Wrong SSH key or user.

Fix:
```bash
# Check which key was used
truffle get my-instance --json | jq .KeyName

# Use explicit key
ssh -i ~/.spawn/keys/spawn-default.pem ec2-user@my-instance.spore.host

# Check user for the AMI
# Amazon Linux: ec2-user, Ubuntu: ubuntu, Debian: admin
```

### `Host key verification failed`

The instance IP reused a known_hosts entry.

Fix:
```bash
ssh-keygen -R my-instance.spore.host
ssh-keygen -R 54.123.45.67
```

## Instance Termination Issues

### Instance Terminates Early (Before TTL)

Idle detection may have triggered.

Check: `spawn logs my-instance | grep idle`

Fix: Increase idle timeout or disable it:
```bash
spawn launch --idle-timeout 0  # disable idle detection
spawn launch --idle-timeout 2h
```

Or extend TTL after launch:
```bash
spawn extend my-instance 2h
```

### `TerminationProtection` Error

If termination protection is enabled:
```bash
aws ec2 modify-instance-attribute \
  --instance-id i-XXXXXXXXX \
  --no-disable-api-termination
spawn terminate my-instance
```

## Cost / Billing Issues

### Unexpected High Costs

Common causes:
1. Instance forgot to terminate — check `truffle ls --all`
2. Long TTL set — review TTL on running instances
3. EBS snapshots left over — check EC2 console > Snapshots
4. Data transfer — outbound data transfer is billed

```bash
# Find all running instances
truffle ls --region all --state running

# Check monthly cost
truffle cost --days 30
```

### Cost Data Not Showing in Dashboard

Cost tracking requires the Cost Explorer API to be enabled in your AWS account.

Enable: AWS Console > Billing > Cost Explorer > Enable Cost Explorer

## DNS Issues

### DNS Name Not Resolving

DNS registration happens asynchronously after launch. Allow 1-2 minutes.

```bash
# Check DNS manually
dig my-instance.spore.host
nslookup my-instance.spore.host

# Check spored registered DNS
spawn logs my-instance | grep dns
```

## Getting More Help

```bash
# Enable debug logging
SPAWN_DEBUG=1 spawn launch --instance-type t3.micro

# View all logs
spawn logs my-instance --tail 200

# Check spored status on instance
spawn ssh my-instance -- sudo systemctl status spored
```

File a bug: https://github.com/spore-host/spore-host/issues
