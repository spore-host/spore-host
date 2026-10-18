---
description: "Verify:"
---

# Installation

## Prerequisites

- An AWS account you can sign in to (see [AWS Authentication](/guides/aws-auth); `aws login` is the recommended way)
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
# Each tool is released from its own repo, and the file name carries the version.
ARCH=$(dpkg --print-architecture)        # amd64 or arm64
for t in truffle spawn; do
  V=$(curl -s https://api.github.com/repos/spore-host/$t/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4 | sed 's/^v//')
  curl -LO "https://github.com/spore-host/$t/releases/download/v$V/${t}_${V}_linux_${ARCH}.deb"
done
sudo dpkg -i truffle_*.deb spawn_*.deb
```

```sh [RHEL / Fedora]
ARCH=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
for t in truffle spawn; do
  V=$(curl -s https://api.github.com/repos/spore-host/$t/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4 | sed 's/^v//')
  sudo rpm -i "https://github.com/spore-host/$t/releases/download/v$V/${t}_${V}_linux_${ARCH}.rpm"
done
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

Then add it to Claude Desktop's config file, `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Use the
path `which spore-host-mcp` prints (Homebrew on Apple Silicon installs to
`/opt/homebrew/bin`, on Intel to `/usr/local/bin`):

```json
{
  "mcpServers": {
    "spore-host": {
      "command": "/opt/homebrew/bin/spore-host-mcp"
    }
  }
}
```

See [AI Assistant (MCP)](/guides/mcp-setup) for Claude Code and other clients.

## Verify a download (optional)

Homebrew, Scoop, and the `.deb`/`.rpm` packages verify integrity for you. If you
download a release archive manually and want to confirm it's authentic, each
release is **signed with keyless [cosign](https://docs.sigstore.dev/)** (Sigstore)
by the tool's GitHub Actions release workflow — no key to fetch, and the signature
is tied to the release's OIDC identity rather than a bucket you'd have to trust.

Every release publishes a `checksums.txt` (SHA-256 of each artifact) and a
`checksums.txt.bundle` (the cosign signature + certificate + transparency-log
entry). Verify the bundle, then check your file against `checksums.txt`. Example
for `spawn` — substitute the repo/tool name and version for `truffle`, `lagotto`,
or `spore-host-mcp`:

```sh
REPO=spawn TOOL=spawn VERSION=0.92.0    # set to the release you downloaded
BASE="https://github.com/spore-host/${REPO}/releases/download/v${VERSION}"

# 1. Fetch the checksum file + its cosign bundle
curl -fsSLO "${BASE}/checksums.txt"
curl -fsSLO "${BASE}/checksums.txt.bundle"

# 2. Verify the checksums.txt was signed by this repo's release workflow
cosign verify-blob \
  --bundle checksums.txt.bundle \
  --certificate-identity-regexp "^https://github.com/spore-host/${REPO}/\.github/workflows/release\.ya?ml@refs/tags/v${VERSION}$" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  checksums.txt
# → Verified OK

# 3. Confirm your downloaded archive matches its checksum
shasum -a 256 --ignore-missing -c checksums.txt
```

If step 2 prints anything other than `Verified OK`, or step 3 doesn't say `OK` for
your file, **do not use the binary** — [report it](https://github.com/spore-host/spore-host/issues/new/choose).

::: tip spored is verified automatically
The `spored` daemon that runs on each instance is signed separately (an AWS KMS
key) and verified at boot by spawn before it runs — you don't need to do anything.
See [Security](/architecture) for the full trust model.
:::

## AWS credentials

spore.host uses whichever credentials are active in your shell — the same ones the AWS CLI uses. The recommended way to obtain them is **`aws login`** (AWS CLI v2.32.0+), which manages short-lived credentials for you; static `aws configure` keys also work.

```sh
aws login                       # sign in
aws sts get-caller-identity     # verify
```

If you use multiple AWS profiles, set the active profile per-command or for the session:

```sh
AWS_PROFILE=my-research-account spawn launch experiment --instance-type g5.xlarge --ttl 8h
export AWS_PROFILE=my-research-account
```

See [AWS Authentication](/guides/aws-auth) for the full model (profiles, `SPORE_*` config, and how authentication relates to permissions).

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
