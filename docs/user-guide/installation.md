# Installation

## Requirements

- macOS 12+ or Linux (x86_64 or arm64)
- Windows: use WSL2
- AWS credentials configured (see [Authentication](authentication.md))

## macOS

### Homebrew (recommended)

```bash
brew tap spore-host/tap
brew install spawn truffle
```

Update: `brew upgrade spawn truffle`

### Pre-built Binary

Download from [GitHub Releases](https://github.com/spore-host/spore-host/releases):

```bash
# macOS arm64 (Apple Silicon)
curl -Lo spawn https://github.com/spore-host/spore-host/releases/latest/download/spawn-darwin-arm64
curl -Lo truffle https://github.com/spore-host/spore-host/releases/latest/download/truffle-darwin-arm64

chmod +x spawn truffle
sudo mv spawn truffle /usr/local/bin/
```

## Linux

### Pre-built Binary

```bash
# x86_64
curl -Lo spawn https://github.com/spore-host/spore-host/releases/latest/download/spawn-linux-amd64
curl -Lo truffle https://github.com/spore-host/spore-host/releases/latest/download/truffle-linux-amd64

chmod +x spawn truffle
sudo mv spawn truffle /usr/local/bin/
```

```bash
# arm64
curl -Lo spawn https://github.com/spore-host/spore-host/releases/latest/download/spawn-linux-arm64
curl -Lo truffle https://github.com/spore-host/spore-host/releases/latest/download/truffle-linux-arm64

chmod +x spawn truffle
sudo mv spawn truffle /usr/local/bin/
```

### Package Managers

```bash
# Debian/Ubuntu (.deb)
curl -Lo spawn.deb https://github.com/spore-host/spore-host/releases/latest/download/spawn_linux_amd64.deb
sudo dpkg -i spawn.deb

# Red Hat/CentOS (.rpm)
curl -Lo spawn.rpm https://github.com/spore-host/spore-host/releases/latest/download/spawn_linux_amd64.rpm
sudo rpm -i spawn.rpm
```

## Build from Source

Requires Go 1.21+:

```bash
git clone https://github.com/spore-host/spore-host.git
cd spore-host

# Build spawn
cd spawn && make build && sudo cp dist/spawn /usr/local/bin/

# Build truffle
cd ../truffle && make build && sudo cp dist/truffle /usr/local/bin/
```

## Verify Installation

```bash
spawn --version
truffle --version
```

## Shell Completion

```bash
# bash
spawn completion bash >> ~/.bashrc

# zsh
spawn completion zsh >> ~/.zshrc

# fish
spawn completion fish > ~/.config/fish/completions/spawn.fish
```

## Uninstall

```bash
# Homebrew
brew uninstall spawn truffle

# Manual
sudo rm /usr/local/bin/spawn /usr/local/bin/truffle
rm -rf ~/.spawn  # config and cache
```

## Upgrade

```bash
# Homebrew
brew upgrade spawn truffle

# Manual: re-download and replace binaries as above
```
