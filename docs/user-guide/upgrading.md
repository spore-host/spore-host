# Upgrading

## Current Version

Check your installed version:
```bash
spawn --version
truffle --version
```

## Upgrade Methods

### Homebrew

```bash
brew upgrade spawn truffle
```

### Pre-built Binary

Download the latest release and replace the binary:

```bash
# macOS arm64
curl -Lo /tmp/spawn https://github.com/spore-host/spore-host/releases/latest/download/spawn-darwin-arm64
sudo mv /tmp/spawn /usr/local/bin/spawn
chmod +x /usr/local/bin/spawn
```

Repeat for truffle.

## Breaking Changes by Version

### v0.22.0

- Dashboard now requires Cost Explorer API enabled for cost charts
- Alert configuration moved to Settings tab in dashboard
- New table columns: DNS Name, Actions

No CLI breaking changes.

### v0.21.0

- `spawn list` renamed to `truffle ls`
- `--lifetime` flag renamed to `--ttl`
- Config file: `lifetime` key renamed to `ttl`

Migration:
```bash
# Update any scripts using spawn list
# Before:
spawn list

# After:
truffle ls
```

### v0.20.0

- Autoscaling feature added (new DynamoDB tables created on first use)
- spored agent updated: instances must be relaunched to get idle detection improvements

### v0.19.0

- `spawn ssh` is now the recommended connection method (replaces manual SSH with key path)
- SSH key stored at `~/.spawn/keys/spawn-default.pem` (moved from `~/.ssh/`)

Migration:
```bash
# Update SSH config if you had manual entries
# Old location: ~/.ssh/spawn-default.pem
# New location: ~/.spawn/keys/spawn-default.pem
```

## Infrastructure Updates

Some upgrades require updating AWS infrastructure (Lambda functions, DynamoDB tables):

```bash
# Re-deploy infrastructure after major upgrade
spawn infra deploy
```

This is only needed when the release notes specify infrastructure changes.

## Rollback

To roll back to a previous version:

```bash
# Homebrew
brew switch spawn <version>

# Manual: download specific release
curl -Lo /tmp/spawn https://github.com/spore-host/spore-host/releases/download/v0.21.0/spawn-darwin-arm64
sudo mv /tmp/spawn /usr/local/bin/spawn
```

## Getting Help

If you encounter issues after upgrading:
1. Check [CHANGELOG](https://github.com/spore-host/spore-host/blob/main/CHANGELOG.md) for breaking changes
2. File a bug at https://github.com/spore-host/spore-host/issues
