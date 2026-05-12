# Release Process for spore-host

This document describes how to create releases for spore-host using GoReleaser.

## Prerequisites

1. **GitHub Repository Setup**
   ```bash
   # Create GitHub repo (if not already created)
   gh repo create spore-host/spore-host --public --source=. --remote=origin

   # Or set remote manually
   git remote add origin git@github.com:spore-host/spore-host.git
   ```

2. **Tap and Bucket Repositories**

   You already have these repositories:
   - `spore-host/homebrew-tap` (for Homebrew formulas)
   - `spore-host/scoop-bucket` (for Scoop manifests)

3. **GitHub Personal Access Tokens**

   Create two PATs with `repo` scope for automated updates:

   **For Homebrew Tap:**
   ```bash
   # Create PAT at: https://github.com/settings/tokens/new
   # Name: "Homebrew Tap Updates"
   # Scopes: repo (full control)

   # Add as GitHub secret
   gh secret set HOMEBREW_TAP_GITHUB_TOKEN --repo spore-host/spore-host
   ```

   **For Scoop Bucket:**
   ```bash
   # Create PAT at: https://github.com/settings/tokens/new
   # Name: "Scoop Bucket Updates"
   # Scopes: repo (full control)

   # Add as GitHub secret
   gh secret set SCOOP_BUCKET_GITHUB_TOKEN --repo spore-host/spore-host
   ```

   **Note:** The `GITHUB_TOKEN` is automatically provided by GitHub Actions.

## Release Process

### 1. Update Version

Update version numbers if hardcoded anywhere (currently using git tags).

### 2. Commit and Push

```bash
# Stage all changes
git add .

# Commit
git commit -m "Release v0.1.0"

# Push to main
git push origin main
```

### 3. Create and Push Tag

```bash
# Create annotated tag
git tag -a v0.1.0 -m "Release v0.1.0: Initial release

Features:
- truffle: EC2 instance type search with Spot pricing
- spawn: Ephemeral instance launcher with TTL auto-termination
- spawnd: Automatic instance monitoring and cleanup
- IAM role auto-creation for spawnd permissions
- SSH key fingerprint matching for key reuse
- S3-based binary distribution with SHA256 verification
- Local user creation on instances
- Comprehensive security and deployment documentation
"

# Push tag to GitHub (this triggers the release workflow)
git push origin v0.1.0
```

### 4. Monitor Release

The GitHub Actions workflow will:
1. Build binaries for all platforms (Linux, macOS, Windows)
2. Create archives with documentation
3. Generate checksums
4. Create GitHub Release with changelog
5. Update Homebrew tap formulas
6. Update Scoop bucket manifests

Monitor at: https://github.com/spore-host/spore-host/actions

### 5. Verify Release

After workflow completes:

**Check GitHub Release:**
```bash
gh release view v0.1.0 --repo spore-host/spore-host
```

**Test Homebrew Installation:**
```bash
brew install spore-host/tap/truffle
brew install spore-host/tap/spawn

truffle version
spawn version
```

**Test Scoop Installation (Windows):**
```powershell
scoop bucket add spore-host https://github.com/spore-host/scoop-bucket
scoop install truffle
scoop install spawn

truffle version
spawn version
```

## Local Testing (Before Release)

Test GoReleaser locally without creating a release:

```bash
# Install goreleaser
brew install goreleaser

# Test build (doesn't publish)
goreleaser release --snapshot --clean

# Check dist/ folder for artifacts
ls -la dist/
```

## Release Checklist

- [ ] All tests passing
- [ ] Documentation updated (README, CHANGELOG)
- [ ] Version tag created (e.g., v0.1.0)
- [ ] GitHub secrets configured (HOMEBREW_TAP_GITHUB_TOKEN, SCOOP_BUCKET_GITHUB_TOKEN)
- [ ] Tag pushed to GitHub
- [ ] GitHub Actions workflow completed successfully
- [ ] GitHub Release created
- [ ] Homebrew formulas updated in spore-host/homebrew-tap
- [ ] Scoop manifests updated in spore-host/scoop-bucket
- [ ] Installation tested on macOS (Homebrew)
- [ ] Installation tested on Windows (Scoop)
- [ ] Installation tested on Linux (manual download)
- [ ] Release announced (if applicable)

## Troubleshooting

### Workflow Fails: "resource not accessible by integration"

**Cause:** Missing GitHub secrets or insufficient permissions.

**Fix:**
1. Verify secrets exist:
   ```bash
   gh secret list --repo spore-host/spore-host
   ```

2. Recreate PATs if needed (see Prerequisites above)

### Homebrew Formula Not Updated

**Cause:** HOMEBREW_TAP_GITHUB_TOKEN missing or invalid.

**Fix:**
1. Check token has `repo` scope
2. Verify token is set as secret:
   ```bash
   gh secret set HOMEBREW_TAP_GITHUB_TOKEN --repo spore-host/spore-host
   ```

### Build Fails: "cannot find module"

**Cause:** Missing dependencies or incorrect module paths.

**Fix:**
```bash
cd truffle && go mod tidy
cd ../spawn && go mod tidy
```

### Archives Don't Include Documentation

**Cause:** Files not present in repository.

**Fix:** Ensure all files listed in `.goreleaser.yaml` archives section exist:
- `README.md`
- `LICENSE`
- `spawn/IAM_PERMISSIONS.md`
- `SECURITY.md`
- etc.

## Automated Release Schedule (Optional)

For automated releases on a schedule, add to `.github/workflows/release.yaml`:

```yaml
on:
  push:
    tags:
      - 'v*'
  schedule:
    - cron: '0 0 * * 0'  # Weekly on Sunday
  workflow_dispatch:  # Manual trigger
```

## Version Naming

Follow semantic versioning (semver):
- `v0.1.0` - Initial release
- `v0.1.1` - Bug fixes
- `v0.2.0` - New features (backwards compatible)
- `v1.0.0` - Stable API, production ready
- `v1.1.0` - New features
- `v2.0.0` - Breaking changes

## Release Notes Template

```markdown
## v0.1.0 - Initial Release

### Features
- 🔍 truffle: EC2 instance type search and Spot pricing
- 🚀 spawn: Ephemeral instance launcher with auto-termination
- 🤖 spawnd: Automatic instance monitoring daemon
- 🔐 IAM: Auto-creation of spawnd instance role
- 🔑 SSH: Fingerprint-based key reuse
- 📦 S3: Binary distribution with SHA256 verification
- 👤 User: Local user creation on instances

### Documentation
- Comprehensive security guide for CISOs
- Enterprise deployment guide
- IAM permissions documentation
- Setup and validation scripts

### Installation
**Homebrew (macOS/Linux):**
\`\`\`bash
brew install spore-host/tap/truffle
brew install spore-host/tap/spawn
\`\`\`

**Scoop (Windows):**
\`\`\`powershell
scoop bucket add spore-host https://github.com/spore-host/scoop-bucket
scoop install truffle spawn
\`\`\`

### Breaking Changes
None (initial release)

### Known Issues
- Wildcard searches (e.g., `t3.*`) are slow due to AWS API limitations

### Contributors
@scttfrdmn
```

## Post-Release

After a successful release:

1. **Update S3 Binaries**
   ```bash
   # Upload new spawnd binaries to S3
   ./scripts/upload_spawnd.sh default us-east-1 us-east-2 us-west-1 us-west-2
   ```

2. **Update SETUP_COMPLETE.md** with release details

3. **Announce** (optional):
   - Social media
   - Company Slack
   - Blog post
   - Reddit /r/aws

---

**Questions?** See `.goreleaser.yaml` for full configuration.
