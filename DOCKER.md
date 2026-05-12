# Using Spawn and Truffle with Docker

The `sporedothost/spawn` Docker image includes both spawn and truffle CLI tools, making it easy to use these tools without installing Go or managing dependencies.

## Quick Start

```bash
# Pull the latest image
docker pull sporedothost/spawn:latest

# Run spawn
docker run --rm sporedothost/spawn:latest --help

# Run truffle
docker run --rm --entrypoint truffle sporedothost/spawn:latest --help
```

## AWS Credentials

Both tools need AWS credentials to interact with AWS services. You can provide credentials in several ways:

### Option 1: Mount AWS credentials directory (Recommended)

```bash
# Mount your local AWS credentials
docker run --rm \
  -v ~/.aws:/home/spawn/.aws:ro \
  sporedothost/spawn:latest --help
```

### Option 2: Pass credentials as environment variables

```bash
docker run --rm \
  -e AWS_ACCESS_KEY_ID=your_access_key \
  -e AWS_SECRET_ACCESS_KEY=your_secret_key \
  -e AWS_DEFAULT_REGION=us-east-1 \
  sporedothost/spawn:latest --help
```

### Option 3: Use AWS profiles

No default AWS profile is set. Specify your profile with:

```bash
docker run --rm \
  -v ~/.aws:/home/spawn/.aws:ro \
  -e AWS_PROFILE=your-profile \
  sporedothost/spawn:latest --help
```

## Using Spawn

Spawn is the default entrypoint, so you can run it directly:

```bash
# List instances
docker run --rm \
  -v ~/.aws:/home/spawn/.aws:ro \
  sporedothost/spawn:latest list

# Launch an instance
docker run --rm \
  -v ~/.aws:/home/spawn/.aws:ro \
  -v ~/.ssh:/home/spawn/.ssh:ro \
  sporedothost/spawn:latest launch \
    --instance-type t3.micro \
    --name test-instance

# Run a sweep
docker run --rm \
  -v ~/.aws:/home/spawn/.aws:ro \
  -v ~/.ssh:/home/spawn/.ssh:ro \
  -v $(pwd):/workspace \
  -w /workspace \
  sporedothost/spawn:latest sweep \
    --config sweep.yaml
```

### Spawn Examples

**Quick test instance:**
```bash
docker run --rm \
  -v ~/.aws:/home/spawn/.aws:ro \
  -v ~/.ssh:/home/spawn/.ssh:ro \
  sporedothost/spawn:latest launch \
    --instance-type t3.micro \
    --ttl 1h
```

**GPU instance for ML:**
```bash
docker run --rm \
  -v ~/.aws:/home/spawn/.aws:ro \
  -v ~/.ssh:/home/spawn/.ssh:ro \
  sporedothost/spawn:latest launch \
    --instance-type g5.xlarge \
    --ami-type gpu \
    --ttl 8h
```

**Parameter sweep from config:**
```bash
docker run --rm \
  -v ~/.aws:/home/spawn/.aws:ro \
  -v ~/.ssh:/home/spawn/.ssh:ro \
  -v $(pwd):/workspace \
  -w /workspace \
  sporedothost/spawn:latest sweep \
    --config experiments.yaml \
    --array-size 10
```

## Using Truffle

Truffle requires overriding the entrypoint:

```bash
# Search for instance types
docker run --rm \
  --entrypoint truffle \
  -v ~/.aws:/home/spawn/.aws:ro \
  sporedothost/spawn:latest search m7i.large

# Check quotas
docker run --rm \
  --entrypoint truffle \
  -v ~/.aws:/home/spawn/.aws:ro \
  sporedothost/spawn:latest quotas --regions us-east-1

# Natural language search
docker run --rm \
  --entrypoint truffle \
  -v ~/.aws:/home/spawn/.aws:ro \
  sporedothost/spawn:latest find "8 vcpus 32gb memory arm"
```

### Truffle Examples

**Find GPU instances:**
```bash
docker run --rm \
  --entrypoint truffle \
  -v ~/.aws:/home/spawn/.aws:ro \
  sporedothost/spawn:latest search "g5.*" \
    --regions us-east-1,us-west-2
```

**Check availability zones:**
```bash
docker run --rm \
  --entrypoint truffle \
  -v ~/.aws:/home/spawn/.aws:ro \
  sporedothost/spawn:latest az m7i.large \
    --regions us-east-1
```

**Get spot pricing:**
```bash
docker run --rm \
  --entrypoint truffle \
  -v ~/.aws:/home/spawn/.aws:ro \
  sporedothost/spawn:latest spot m7i.large \
    --regions us-east-1
```

**Check ML capacity:**
```bash
docker run --rm \
  --entrypoint truffle \
  -v ~/.aws:/home/spawn/.aws:ro \
  sporedothost/spawn:latest capacity \
    --instance-types p5.48xlarge
```

**JSON output:**
```bash
docker run --rm \
  --entrypoint truffle \
  -v ~/.aws:/home/spawn/.aws:ro \
  sporedothost/spawn:latest search m7i.large \
    --output json | jq '.'
```

## Pipeline: Truffle → Spawn

Use truffle to find instances, then pipe to spawn to launch them:

```bash
# Find and launch
docker run --rm \
  --entrypoint truffle \
  -v ~/.aws:/home/spawn/.aws:ro \
  sporedothost/spawn:latest search "m7i.*" \
    --regions us-east-1 \
    --output json | \
docker run --rm -i \
  -v ~/.aws:/home/spawn/.aws:ro \
  -v ~/.ssh:/home/spawn/.ssh:ro \
  sporedothost/spawn:latest launch --from-stdin
```

## Shell Aliases

Make it easier to use by adding shell aliases:

```bash
# Add to ~/.bashrc or ~/.zshrc
alias spawn='docker run --rm -v ~/.aws:/home/spawn/.aws:ro -v ~/.ssh:/home/spawn/.ssh:ro sporedothost/spawn:latest'
alias truffle='docker run --rm --entrypoint truffle -v ~/.aws:/home/spawn/.aws:ro sporedothost/spawn:latest'

# Now you can use them directly:
spawn list
truffle search m7i.large
```

## Working with Files

Mount volumes to access local files:

```bash
# Read sweep config from current directory
docker run --rm \
  -v ~/.aws:/home/spawn/.aws:ro \
  -v ~/.ssh:/home/spawn/.ssh:ro \
  -v $(pwd):/workspace \
  -w /workspace \
  sporedothost/spawn:latest sweep --config ./sweep.yaml

# Output results to local directory
docker run --rm \
  --entrypoint truffle \
  -v ~/.aws:/home/spawn/.aws:ro \
  -v $(pwd):/workspace \
  -w /workspace \
  sporedothost/spawn:latest search "m7i.*" \
    --output json > instances.json
```

## Interactive Shell

Run an interactive shell with both tools available:

```bash
docker run --rm -it \
  --entrypoint /bin/bash \
  -v ~/.aws:/home/spawn/.aws:ro \
  -v ~/.ssh:/home/spawn/.ssh:ro \
  sporedothost/spawn:latest

# Inside the container:
spawn list
truffle search m7i.large
aws ec2 describe-instances
```

## Available Tools

The image includes these utilities:

- **spawn** - EC2 instance launcher
- **truffle** - Instance type discovery
- **aws-cli** - AWS command line interface
- **ssh** - SSH client for connecting to instances
- **bash** - Shell scripting
- **jq** - JSON processing
- **curl** - HTTP requests

## Troubleshooting

### Permission denied (SSH keys)

If you get permission errors with SSH keys:

```bash
# Ensure proper permissions on mounted keys
chmod 600 ~/.ssh/id_rsa
chmod 644 ~/.ssh/id_rsa.pub
```

### AWS credentials not found

```bash
# Verify credentials are mounted
docker run --rm \
  -v ~/.aws:/home/spawn/.aws:ro \
  --entrypoint /bin/sh \
  sporedothost/spawn:latest \
  -c "ls -la /home/spawn/.aws"

# Check which profile is being used
docker run --rm \
  -v ~/.aws:/home/spawn/.aws:ro \
  --entrypoint /bin/sh \
  sporedothost/spawn:latest \
  -c "echo Profile: $AWS_PROFILE"
```

### Region not specified

```bash
# Explicitly set region
docker run --rm \
  -v ~/.aws:/home/spawn/.aws:ro \
  -e AWS_DEFAULT_REGION=us-east-1 \
  sporedothost/spawn:latest list
```

## Building Locally

To build the image from source:

```bash
# From the repository root
docker build -f spawn/Dockerfile -t sporedothost/spawn:local .

# Test the local build
docker run --rm sporedothost/spawn:local --version
docker run --rm --entrypoint truffle sporedothost/spawn:local version
```

## Image Tags

- `latest` - Latest stable release
- `v0.22.0` - Specific version (when released)
- `dev` - Development builds from main branch

## Security Notes

1. **Read-only mounts**: Always mount credentials as read-only (`:ro`)
2. **Minimal permissions**: Use IAM roles with least privilege
3. **No credentials in image**: Never build credentials into the image
4. **Temporary containers**: Use `--rm` flag to clean up after use

## Getting Help

```bash
# Spawn help
docker run --rm sporedothost/spawn:latest --help
docker run --rm sporedothost/spawn:latest launch --help

# Truffle help
docker run --rm --entrypoint truffle sporedothost/spawn:latest --help
docker run --rm --entrypoint truffle sporedothost/spawn:latest search --help
```

## Version Information

```bash
# Check versions
docker run --rm sporedothost/spawn:latest --version
docker run --rm --entrypoint truffle sporedothost/spawn:latest version
```

## More Information

- Spawn documentation: [spawn/README.md](spawn/README.md)
- Truffle documentation: [truffle/README.md](truffle/README.md)
- Docker Hub: https://hub.docker.com/r/sporedothost/spawn
- GitHub: https://github.com/spore-host/spore-host
