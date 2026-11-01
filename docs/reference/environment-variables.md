---
description: "spore.host tools read configuration from environment variables and ~/.spawn/config.yaml."
---

# Environment Variables

spore.host tools read configuration from environment variables and `~/.spawn/config.yaml`. Environment variables take precedence over config file values.

## AWS credentials

spore.host uses the standard AWS credential chain — no custom variables required. The recommended way to populate it is [`aws login`](/guides/aws-auth) (AWS CLI v2.32.0+); the variables below are for profile selection or the static-key fallback.

| Variable | Description |
|----------|-------------|
| `AWS_PROFILE` | AWS CLI profile to use (recommended over static keys) |
| `AWS_REGION` | Default AWS region |
| `AWS_ACCESS_KEY_ID` | Static access key — fallback only; prefer `aws login` / profiles |
| `AWS_SECRET_ACCESS_KEY` | Static secret key (fallback) |
| `AWS_SESSION_TOKEN` | Temporary session token (for assumed roles) |

## spore.host config

The suite-wide [`sporeconfig`](/guides/aws-auth) layer (all CLIs), resolved flag > env > `~/.config/spore/config.toml` > default:

| Variable | Description |
|----------|-------------|
| `SPORE_PROFILE` | AWS profile for spore.host tools (overrides `AWS_PROFILE` for them) |
| `SPORE_REGION` | Default region for spore.host tools |
| `SPORE_ACCOUNT` | Expected AWS account ID. spawn refuses to act when your credentials resolve to a different account, or to one it can't determine (since v0.135.2). truffle and lagotto enforce the `--account` flag, not this variable. See [the account guard](/guides/aws-auth#the-account-guard) |

```sh
# Use a named profile
export AWS_PROFILE=research-account

# Or override region for one command
AWS_REGION=eu-west-1 spawn launch --name eu-test
```

## Update notice

| Variable | Description |
|----------|-------------|
| `SPORE_NO_UPDATE_CHECK` | Set to any value to turn off the "A newer version … is available" notice that spawn and truffle print to stderr after a command, and the background release check behind it. `CI` (any value) does the same. From libs v0.51.4 (the spawn and truffle releases that include it), the notice and check are also skipped automatically when stderr is not a terminal, for example when a script or batch harness captures it. Explicit checks (`spawn version`, `truffle version`) ignore all three. |

## Slack and Teams integration

| Variable | Description |
|----------|-------------|
| `SLACK_CLIENT_ID` | OAuth client ID for spore-bot Slack app |
| `SLACK_CLIENT_SECRET` | OAuth client secret for spore-bot Slack app |
| `SPORE_NOTIFY_URL` | Notification Lambda URL for lifecycle notifications (overrides config) |

## Configuration file location

spawn reads its config from `~/.spawn/config.yaml`; the path can't be changed.
(`SPAWN_CONFIG` is something else: it points spored's local provider, for
non-EC2 hosts, at its config file, by default `/etc/spawn/local.yaml`.)

The shared spore.host settings (profile, region, account) live in
`~/.config/spore/config.toml`, under `$XDG_CONFIG_HOME` if that's set.

## Debugging

```sh
# See which identity and account your credentials resolve to
aws sts get-caller-identity

# Check the whole environment: credentials, account, permissions, VPC, reaper
spawn doctor

# Copy spawn's audit trail and diagnostic log lines to stderr
spawn -v launch ...
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
