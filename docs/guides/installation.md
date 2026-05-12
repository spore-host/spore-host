# Installation

## Prerequisites

- An AWS account with credentials configured (`aws configure` or environment variables)
- macOS, Linux, or Windows

## Core tools

**Truffle** and **Spawn** are the tools you'll use for every workflow. Install both.

::: code-group

```sh [macOS / Linux (Homebrew)]
brew install spore-host/tap/truffle
brew install spore-host/tap/spawn
```

```powershell [Windows (Scoop)]
scoop bucket add spore-host https://github.com/spore-host/scoop-bucket
scoop install truffle
scoop install spawn
```

```sh [Debian / Ubuntu]
curl -LO https://github.com/spore-host/spore-host/releases/latest/download/truffle_linux_amd64.deb
curl -LO https://github.com/spore-host/spore-host/releases/latest/download/spawn_linux_amd64.deb
sudo dpkg -i truffle_linux_amd64.deb spawn_linux_amd64.deb
```

```sh [RHEL / Fedora]
sudo rpm -i https://github.com/spore-host/spore-host/releases/latest/download/truffle_linux_amd64.rpm
sudo rpm -i https://github.com/spore-host/spore-host/releases/latest/download/spawn_linux_amd64.rpm
```

:::

Verify:

```sh
truffle --version
spawn --version
```

## Optional tools

Install these as your workflow grows.

### Lagotto — capacity watching

```sh
brew install spore-host/tap/lagotto   # macOS / Linux
scoop install lagotto                 # Windows
```

### MCP Server — AI assistant integration

```sh
brew install spore-host/tap/spore-host-mcp
```

Then add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "spore-host": {
      "command": "/usr/local/bin/spore-host-mcp"
    }
  }
}
```

## AWS credentials

spore.host uses whichever credentials are active in your shell — the same ones the AWS CLI uses. No additional configuration is required if you've already run `aws configure`.

```sh
# Verify credentials are working
aws sts get-caller-identity
```

If you use multiple AWS profiles, you can set the active profile per-command:

```sh
AWS_PROFILE=my-research-account spawn launch --name experiment --instance-type g5.xlarge --ttl 8h
```

Or set it as a default for your shell session:

```sh
export AWS_PROFILE=my-research-account
```

## IAM permissions

Your AWS credentials need permission to describe and launch EC2 instances, create tags, and set up an IAM instance profile for the spored daemon. The minimal policy is documented in the [IAM Permissions reference](/reference/iam-permissions).

::: tip Using a shared account?
If your AWS account is managed by your institution, you may need to ask your cloud administrator to attach the spore.host policy to your user or role.
:::

## Save your defaults

If you always launch with the same Slack workspace ID, idle timeout, or active processes, save them so you don't have to type them every time:

```sh
spawn defaults set slack-workspace T03NE3GTY
spawn defaults set idle-timeout 1h
spawn defaults set active-processes rsession   # for RStudio users
spawn defaults list
```

These are stored in `~/.spawn/config.yaml` and applied to every `spawn launch` unless overridden on the command line. See [Configuration](/reference/configuration) for all options.
