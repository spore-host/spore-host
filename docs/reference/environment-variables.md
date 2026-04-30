# Environment Variables

spore.host tools read configuration from environment variables and `~/.spawn/config.yaml`. Environment variables take precedence over config file values.

## AWS credentials

spore.host uses the standard AWS credential chain — no custom variables required.

| Variable | Description |
|----------|-------------|
| `AWS_PROFILE` | AWS CLI profile to use (recommended over static keys) |
| `AWS_REGION` | Default AWS region |
| `AWS_ACCESS_KEY_ID` | Static access key (prefer profiles or IAM roles) |
| `AWS_SECRET_ACCESS_KEY` | Static secret key |
| `AWS_SESSION_TOKEN` | Temporary session token (for assumed roles) |

```sh
# Use a named profile
export AWS_PROFILE=research-account

# Or override region for one command
AWS_REGION=eu-west-1 spawn launch --name eu-test
```

## Slack and Teams integration

| Variable | Description |
|----------|-------------|
| `SLACK_CLIENT_ID` | OAuth client ID for spore-bot Slack app |
| `SLACK_CLIENT_SECRET` | OAuth client secret for spore-bot Slack app |
| `SPORE_BOT_NOTIFY_URL` | Webhook URL for lifecycle notifications (overrides config) |

## Configuration file location

By default spore.host looks for config at `~/.spawn/config.yaml`. Override with:

```sh
SPAWN_CONFIG=/path/to/config.yaml spawn launch ...
```

## Debugging

```sh
# Enable verbose AWS SDK logging
AWS_SDK_LOAD_CONFIG=1

# See what credentials are being used
aws sts get-caller-identity
```

## Per-command overrides

Most configuration can be passed as flags rather than environment variables:

```sh
# Region, profile, and TTL as flags
spawn launch \
  --region us-west-2 \
  --profile research-account \
  --ttl 4h \
  --name my-instance
```

See `spawn launch --help` for the complete flag reference.
