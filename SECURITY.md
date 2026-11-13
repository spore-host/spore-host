# Security Overview for spore.host

**Audience:** CISOs, Cloud Administrators, Security Engineers

**Purpose:** Security assessment and operational guidance for deploying spore.host tools in AWS environments.

> **The name is spore.host, but spore.host is not the host.** It never holds your
> AWS credentials and never runs your compute. Everything runs in **your own AWS
> account** with **your own credentials**. For the full trust/data-flow map, see
> [Security, credentials & data flow](docs/architecture.md).

---

## Executive Summary

**spore.host** is a suite of command-line tools (plus one in-instance agent) for
AWS EC2 instance discovery and ephemeral, self-terminating compute. Its
components:

- **truffle** — EC2 instance-type / price / quota search (read-only).
- **spawn** — EC2 instance launcher and lifecycle manager (read/write).
- **spored** — the in-instance agent spawn installs on every instance; enforces
  TTL, idle, completion, and cost rules from *inside* the instance.
- **lagotto** — capacity watcher that waits for scarce instance types and launches
  when they appear.
- **spore-bot** — optional chat control (Slack/Teams) via a hosted Lambda.
- **MCP server** — exposes a read-mostly subset of operations to AI assistants
  (search, status, stop, terminate, extend — **no launch**).
- **plugin registry** ([spore-plugins](https://github.com/spore-host/spore-plugins)) —
  optional post-launch software installers; official plugins are **cosign-signed**
  and verified by spawn before install (see §4).

**Security Model:** your credentials never leave your machine; least-privilege
IAM; explicit resource tagging; in-instance lifecycle enforcement with an
out-of-band backstop; automatic cleanup of ephemeral resources.

**Risk Profile:** Medium — requires EC2 launch permissions and one-time IAM role
creation for the spored instance profile.

**Compliance:** spore.host does not centrally receive or store workload data.
Supports CloudTrail auditing and resource tagging; compliance obligations remain
with the user's AWS environment, configuration, and controls (see §5).

---

## 1. Architecture Overview

### truffle (Read-Only Tool)

**Purpose:** Search and compare EC2 instance types across regions

**AWS Services Used:**
- EC2 DescribeInstanceTypes (read-only)
- EC2 DescribeRegions (read-only)
- EC2 DescribeAvailabilityZones (read-only)

**Security Posture:** Zero write permissions, no resource creation

**Data Access:** Only AWS service metadata (pricing, specifications)

**Risk Assessment:** **LOW** - Cannot modify infrastructure

---

### spawn (Instance Launcher)

**Purpose:** Launch ephemeral EC2 instances with automatic termination

**AWS Services Used:**
- **EC2:** Launch, terminate, and query instances
- **IAM:** Create service role for spored agent (once per account)
- **SSM Parameter Store:** Query latest Amazon Linux AMI IDs
- **S3:** Download spored agent binary (public read, SHA256-verified)

**Security Posture:** Requires EC2 launch permissions and limited IAM role creation

**Resource Lifecycle:** Automatic cleanup via TTL and idle detection

**Risk Assessment:** **MEDIUM** - Can launch instances (cost implications)

---

## 2. IAM Permissions Required

### For truffle (Read-Only)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeRegions",
        "ec2:DescribeAvailabilityZones"
      ],
      "Resource": "*"
    }
  ]
}
```

**Compatible with:** ReadOnlyAccess, ViewOnlyAccess, PowerUserAccess

---

### For spawn (Minimum Required)

See `spawn/IAM_PERMISSIONS.md` for complete policy.

**Summary:**
- **EC2:** Launch, terminate, describe instances (standard compute access)
- **IAM:** Create `spored-instance-role` and `spored-instance-profile` (one-time setup)
- **SSM:** Read `/aws/service/ami-amazon-linux-latest/*` (AMI auto-detection)

**Compatible with:** the least-privilege baseline in `docs/reference/iam-permissions.md` (see below). Not with PowerUserAccess plus IAM grants.

**NOT Compatible with:** PowerUserAccess alone (missing IAM permissions)

---

### PowerUser + spawn IAM Policy

Don't pair `PowerUserAccess` with spawn's IAM grants. `PowerUserAccess`
grants `ec2:CreateTags` on every resource with no condition, which defeats
spawn's grants that are scoped by the `spawn:managed` tag. Use the
[recommended least-privilege baseline](docs/reference/iam-permissions.md#recommended-least-privilege-baseline)
instead.

An earlier version of this section gave a supplementary policy granting
`iam:CreateRole`, `iam:PutRolePolicy` and `iam:PassRole` on
`spored-instance-role` with no permissions boundary. Remove it if you
applied it. Holding those three together with `ec2:RunInstances` lets a
caller give an instance any permissions. The baseline grants spawn's role
writes only on roles carrying spawn's permissions boundary.

---

## 3. IAM Role Created by spawn

### spored-instance-role

**Purpose:** Allows spored agent (running on EC2 instances) to self-manage based on tags

**Trust Policy:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ec2.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

**Permissions Policy:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeTags",
        "ec2:DescribeInstances"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ec2:TerminateInstances",
        "ec2:StopInstances"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "ec2:ResourceTag/spawn:managed": "true"
        }
      }
    }
  ]
}
```

**Security Controls:**
- ✅ Can only terminate/stop instances tagged `spawn:managed=true`
- ✅ Cannot terminate instances launched by other tools
- ✅ Cannot modify IAM policies
- ✅ Cannot access S3, databases, or other AWS services
- ✅ Scoped to EC2 instance lifecycle only

---

## 4. Security Features

### Automatic Resource Cleanup

**TTL (Time-To-Live):**
- User specifies maximum instance lifetime (e.g., `--ttl 8h`)
- spored agent monitors uptime
- Terminates instance when TTL expires
- **Benefit:** Prevents forgotten instances running indefinitely

**Idle Detection:**
- User specifies idle timeout (e.g., `--idle-timeout 30m`)
- spored monitors SSH sessions and CPU utilization
- Terminates or hibernates when idle threshold reached
- **Benefit:** Reduces cost for intermittent workloads

**Laptop Independence:**
- spored runs as systemd service on the instance (not laptop)
- Auto-termination works even if laptop is off or disconnected
- **Benefit:** Prevents orphaned resources from VPN disconnections

---

### Resource Tagging

All instances launched by spawn are tagged:

```
spawn:managed = true
spawn:root = true
spawn:created-by = spawn
spawn:version = <spawn version that launched it>
spawn:ttl = <duration>           (if specified)
spawn:idle-timeout = <duration>  (if specified)
```

**Benefits:**
- Cost allocation and chargeback
- Automated cleanup policies (AWS Config, Lambda)
- Compliance reporting (which instances have TTL?)
- Security auditing (CloudTrail queries by tag)

---

### Binary Distribution Security

**How spored reaches an instance:** at boot, the instance's user-data downloads
the spored binary and a `.sha256` checksum from a public, regional S3 bucket
(`spawn-binaries-<region>`), verifies the checksum, then installs and runs it.

**Two layers protect the download:**

- ✅ **Publisher signature (authenticity).** As of spawn v0.91.1, each spored
  binary is signed with a spore.host-held **KMS asymmetric key** (ECDSA_SHA_256,
  `kms:Sign` — the private key never leaves KMS), and the `.sig` is published
  alongside the binary. The bootstrap verifies that signature with `openssl`
  against a public key **compiled into spawn** — whose own release is
  independently trusted via Homebrew / GitHub Releases — *before executing
  spored*, and **fails closed** on a missing or invalid signature. Because the
  trust root is the spawn binary, **not** the S3 bucket, an attacker who rewrites
  the bucket cannot forge a signature without the KMS key. (spore-host#440)
- ✅ **Corruption detection.** The `.sha256` still guards against an incomplete or
  corrupted download (truncated transfer, bit-rot) as a cheap first check.

Why the checksum alone was not enough (and why the signature was added): the
`.sha256` is served from the **same bucket** as the binary, so an attacker who
could modify the binary could also replace the checksum — a same-origin checksum
proves integrity (not corrupted) but **not authenticity** (from the real
publisher). The signature closes that gap by moving the trust root out of the
bucket.

> **Related — plugin signing.** Official **plugins** in the registry are also
> signed, but with cosign/sigstore keyless (GitHub Actions OIDC → Fulcio/Rekor),
> verified by spawn before install (§4, *Plugin supply chain*). Plugins use
> keyless; the spored *binaries* use the KMS key above, because the bootstrap
> verifies at boot in bash before any sigstore tooling exists.

**S3 Bucket Policy (public read, restricted write):**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadSporedBinaries",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::spawn-binaries-*/spored-*"
    }
  ]
}
```
Write access to the bucket is restricted to the release pipeline; public access
is read-only for the binary objects.

---

### Plugin supply chain

Optional plugins (post-launch software installers) are resolved and, for official
plugins, cryptographically verified before anything runs:

- Official plugin releases are **cosign-signed keyless** in CI (a GitHub Actions
  OIDC identity → Fulcio certificate + Rekor transparency-log entry).
- `spawn` verifies the signature by default for an official versioned reference,
  pinning the signing identity to the spore-plugins release workflow. A missing or
  invalid signature is a hard failure (`--insecure` bypasses it for local dev).
- Each plugin also ships a checksum manifest verified against the fetched
  `plugin.yaml`, and a plugin's declared `permissions:` block is enforced against
  its steps at publish time.

This closes the "who authored this code that runs on my instance" question for
plugins. See the [registry supply-chain design](https://github.com/spore-host/spore-plugins).

---

### SSH Key Management

**Fingerprint-Based Key Reuse:**
- spawn calculates MD5 fingerprint of local SSH public key
- Searches AWS EC2 for existing key pair with matching fingerprint
- Reuses existing key if found (no duplicate uploads)
- Only uploads if no matching key exists

**Benefits:**
- No duplicate keys cluttering AWS account
- Consistent key usage across multiple launches
- User can pre-import keys with custom names

**Security:**
- Only public keys handled (private keys never leave laptop)
- Keys stored in AWS EC2 KeyPairs (standard AWS service)
- No custom key storage or management

---

## 5. Audit and Compliance

### CloudTrail Events

All spawn operations generate CloudTrail events:

**IAM Role Creation:**
```
CreateRole (spored-instance-role)
PutRolePolicy (spored-policy)
CreateInstanceProfile (spored-instance-profile)
AddRoleToInstanceProfile
```

**Instance Launch:**
```
RunInstances
  - Tags: spawn:managed=true, spawn:ttl=8h
  - IamInstanceProfile: spored-instance-profile
  - UserData: <base64-encoded script>
```

**Instance Termination (by spored):**
```
TerminateInstances
  - InitiatedBy: spored (via instance profile role)
  - Reason: TTL expired / idle timeout
```

**Query Examples:**

Find all spawn-launched instances:
```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceType,AttributeValue=AWS::EC2::Instance \
  --query 'Events[?contains(CloudTrailEvent, `spawn:managed`)]'
```

Find instances terminated by spored:
```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=TerminateInstances \
  --query 'Events[?contains(CloudTrailEvent, `spored-instance-role`)]'
```

---

### Cost Control

**Built-In Mechanisms:**
1. **TTL Enforcement:** Hard limit on instance runtime
2. **Idle Detection:** Automatic termination of unused instances
3. **Resource Tagging:** Cost allocation via `spawn:*` tags
4. **Spot Instance Support:** `--spot` flag for 70% savings

**Recommended Controls:**
1. **AWS Budgets:** Alert on `spawn:managed=true` tag spend
2. **Service Control Policies:** Limit instance types per OU
3. **IAM Conditions:** Require `--ttl` flag via policy conditions
4. **Cost Anomaly Detection:** Alert on unusual spawn usage patterns

**Example Budget:**
```bash
aws budgets create-budget \
  --account-id 123456789012 \
  --budget file://spawn-budget.json
```

```json
{
  "BudgetName": "spawn-instances-monthly",
  "BudgetLimit": {
    "Amount": "1000",
    "Unit": "USD"
  },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST",
  "CostFilters": {
    "TagKeyValue": ["user:spawn:managed$true"]
  }
}
```

---

### Compliance Considerations

**The key fact:** spore.host does **not** centrally receive, process, or store
your workload data. Instances run in your VPC, under your account, with your
credentials; any data on them is placed there by you. spore.host therefore cannot
confer compliance — compliance obligations remain with your AWS environment, the
services you enable, your configuration, your data handling, and your
institutional controls. Do not assume a workload is compliant merely because the
instance runs in your own VPC.

What spore.host *does* provide that supports a compliance program:

**GDPR / Data Residency:**
- spawn respects the region you choose (`--region`); no cross-region movement of
  your data by spore.host.

**PCI-DSS / HIPAA:**
- No workload data flows to spore.host; instances run in your VPC under your
  network controls. EBS encryption is supported. Meeting these frameworks depends
  on *your* configuration and BAAs/controls, not on spore.host.

**SOC 2 / ISO 27001:**
- CloudTrail captures all spawn operations; resource tagging supports inventory;
  automatic cleanup reduces standing surface area. These are inputs to your
  controls, not attestations by spore.host.

---

### Lifecycle guarantee by deployment mode

The TTL guarantee ("every protected instance has a hard termination deadline") is
enforced in two layers: **spored** inside the instance, and an optional
**out-of-band reaper** that acts as a backstop if spored can't. What you get
depends on which you deploy:

| Mode | spored (in-instance) | Out-of-band reaper | Workload data leaves account | Failure guarantee |
|------|:---:|:---:|:---:|---|
| **CLI only** (default) | Yes | No | No | Instance-local enforcement: spored terminates at TTL. If spored itself is disabled/killed, only your AWS-side controls (Budgets/SCPs) remain. |
| **Self-hosted backstop** | Yes | Yes (in your account) | No | Dual enforcement: the reaper terminates past-deadline instances even if spored fails. |
| **Hosted integrations** | Yes | Yes / optional | Selected metadata only (never credentials or workload data) | Dual enforcement when the reaper is enabled. |

Notes on the reaper (see
[spawn/lambda/ttl-reaper](https://github.com/spore-host/spawn/tree/main/lambda/ttl-reaper)):

- It is **not enabled by default** and ships in **dry-run** (logs "would reap" +
  notifies; does not terminate) until an operator flips it to enforce mode after
  verification.
- It assumes a **narrow per-account cross-account role you grant** (scoped to
  terminating past-deadline `spawn:managed` instances) — it never holds your
  credentials.
- With **no reaper configured**, the hard guarantee is provided by spored alone;
  the reaper is the backstop for the case where spored can't act. Verify spored is
  running and the deadline is set with `spawn status`.

---

## 6. Risk Assessment

### Identified Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Excessive instance launches | Medium | AWS Budgets, SCPs, `--ttl` requirement |
| IAM role privilege escalation | Low | Role scoped to `spawn:managed=true` only |
| spored binary corruption | Low | SHA256 verification, HTTPS |
| spored binary tampering (bucket compromise) | Low | Publisher signature verified at boot against a key compiled into spawn (KMS-signed release, #440); a bucket rewrite can't forge it. Plus S3 bucket write-access controls. |
| Forgotten instances | Low | TTL enforcement, idle detection |
| Insider threat (malicious user) | Medium | CloudTrail auditing, IAM least privilege |
| Credential exposure | Medium | No credentials in user-data, IMDSv2 supported |

### Mitigations Summary

✅ **Least Privilege IAM:** Users only get permissions they need
✅ **Resource Tagging:** All resources identifiable and auditable
✅ **Automatic Cleanup:** TTL/idle detection prevents resource leaks
✅ **Audit Trail:** CloudTrail captures all operations
✅ **Cost Controls:** Budgets, SCPs, Spot instances
✅ **Binary Integrity (corruption):** SHA256 verification of spored downloads
✅ **Plugin Authenticity:** official plugins cosign-signed + verified by spawn
✅ **spored Binary Authenticity:** each spored binary is KMS-signed at release and its signature is verified at boot against a key compiled into spawn, fail-closed (#440)
✅ **Network Security:** User controls VPC, security groups, subnets

---

## 7. Deployment Recommendations

### For Small Teams (< 50 users)

1. **IAM Users with spawn policy** (see `IAM_PERMISSIONS.md`)
2. **AWS Budget alert** at $500/month
3. **CloudTrail enabled** (standard AWS best practice)
4. **Require `--ttl` via documentation** (not enforced)

### For Enterprises (> 50 users)

1. **IAM Groups:**
   - `spawn-power-users`: Full spawn access
   - `spawn-basic-users`: spawn + instance type restrictions via SCP

2. **Service Control Policies:**
   ```json
   {
     "Effect": "Deny",
     "Action": "ec2:RunInstances",
     "Resource": "arn:aws:ec2:*:*:instance/*",
     "Condition": {
       "StringNotLike": {
         "ec2:InstanceType": [
           "t3.*",
           "t4g.*",
           "m7i.large",
           "m7i.xlarge"
         ]
       },
       "StringEquals": {
         "aws:PrincipalTag/spawn-user": "true"
       }
     }
   }
   ```

3. **Mandatory TTL via IAM Policy:**
   ```json
   {
     "Effect": "Deny",
     "Action": "ec2:RunInstances",
     "Resource": "arn:aws:ec2:*:*:instance/*",
     "Condition": {
       "StringNotEquals": {
         "aws:RequestTag/spawn:ttl": "*"
       }
     }
   }
   ```
   *(Note: Requires spawn to always set TTL tag)*

4. **Cost Allocation Tags:**
   - Enable `spawn:*` tags as cost allocation tags
   - Monthly reports by team/project

5. **Security Hub Integration:**
   - Custom AWS Config rule: "Instances must have `spawn:ttl` tag"
   - Alert on non-compliant spawn instances

---

## 8. Incident Response

### Scenario: Unauthorized Instance Launch

**Detection:**
```bash
# Find all spawn instances
aws ec2 describe-instances \
  --filters "Name=tag:spawn:managed,Values=true" \
  --query 'Reservations[].Instances[].[InstanceId,LaunchTime,State.Name]'

# Check CloudTrail for who launched
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceType,AttributeValue=AWS::EC2::Instance
```

**Response:**
1. Identify user via CloudTrail `userIdentity`
2. Terminate instance: `aws ec2 terminate-instances --instance-ids i-xxxxx`
3. Review user IAM permissions
4. Check AWS Budget impact

---

### Scenario: spored Role Privilege Escalation Attempt

**Detection:** CloudWatch Logs Insights query:

```
fields @timestamp, errorCode, errorMessage
| filter eventSource = "ec2.amazonaws.com"
| filter userIdentity.principalId like /spored-instance-role/
| filter errorCode like /Unauthorized/
```

**Response:**
1. Identify instance: Extract instance ID from CloudTrail
2. Terminate instance immediately
3. Review spored role policy (should be read-only except for self-termination)
4. Check for IAM policy modifications

---

## 9. Validation and Testing

### Pre-Deployment Checklist

- [ ] Run `./scripts/validate-permissions.sh <aws-profile>` for each user
- [ ] Create test AWS Budget for spawn resources
- [ ] Enable CloudTrail in all regions
- [ ] Test IAM role creation (first spawn launch)
- [ ] Verify TTL enforcement (launch instance with `--ttl 5m`)
- [ ] Verify idle detection (launch instance with `--idle-timeout 10m`)
- [ ] Test Spot instances (`--spot` flag)
- [ ] Review CloudTrail events for spawn operations

### Security Testing

```bash
# Test 1: Verify spored cannot terminate non-spawn instances
aws ec2 run-instances --image-id ami-xxxxx --instance-type t3.micro
# (manually launched, no spawn:managed tag)
# spored should fail to terminate this

# Test 2: Verify TTL enforcement
echo '[{"instance_type":"t3.micro","region":"us-east-1"}]' | \
  spawn launch --ttl 5m
# Wait 6 minutes, verify instance terminated

# Test 3: Verify SHA256 verification
# Corrupt spored binary on S3, verify instance launch fails

# Test 4: Verify CloudTrail logging
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=RunInstances
```

---

## 10. Code-Level Security Hardening

### Command Injection Protection

spawn implements comprehensive protection against shell command injection attacks:

**Security Package** (`spawn/pkg/security`):
- `ShellEscape()`: Properly escapes strings for POSIX shell arguments
- `ValidateUsername()`: Validates usernames against safe patterns
- `ValidateCommand()`: Detects potentially dangerous shell characters

**Protected Operations**:
1. **SSH Commands** (`spawn/cmd/config.go`):
   - Config keys and values properly escaped before SSH execution
   - Prevents injection via `spawn config set "key" "value; rm -rf /"`

2. **User Data Scripts** (`spawn/cmd/launch.go`):
   - Usernames validated against regex: `^[a-z][a-z0-9_-]{0,31}$`
   - SSH keys validated as proper base64
   - All dynamic values shell-escaped in bash scripts

3. **MPI Templates** (`spawn/pkg/userdata/mpi.go`):
   - Custom `shellEscape` template function
   - MPI commands properly escaped: `{{.MPICommand | shellEscape}}`

4. **Storage Mounting** (`spawn/pkg/userdata/storage.go`):
   - Mount paths validated and escaped
   - Filesystem DNS names escaped in mount commands

**Test Coverage**: security-critical paths are covered by unit tests with
attack-pattern fuzzing; current coverage is reported by CI on each repo.

---

### Path Traversal Protection

All file path operations are validated to prevent directory traversal attacks:

**Validation Functions**:
- `ValidatePathForReading()`: Blocks `../../etc/passwd` style attacks
- `ValidateMountPath()`: Restricts mounts to `/mnt`, `/data`, `/scratch`
- `SanitizePath()`: Removes traversal sequences for safe logging

**Blocked Paths**:
- `/etc/` - System configuration
- `/sys/` - System kernel interface
- `/proc/` - Process information
- `/root/` - Root home directory
- `/boot/` - Boot loader files
- `/dev/` - Device files
- `/var/lib/` - System libraries

**Protected Operations**:
1. **User Data File Reads** (`spawn/cmd/launch.go`):
   - Both `--user-data-file` and `--user-data @file` validated
   - Prevents reading system files

2. **Job Result Uploads** (`spawn/pkg/agent/queue_runner.go`):
   - Glob patterns validated before expansion
   - Prevents uploading sensitive files

---

### Credential Protection

Sensitive credentials are protected from exposure:

**Security Functions**:
- `MaskSecret()`: Masks secrets showing only first/last 4 chars
- `MaskURL()`: Shows scheme and domain, masks path
- `SanitizeForLog()`: Removes AWS keys from log messages
- `EncryptSecret()`/`DecryptSecret()`: KMS-based encryption (ready for use)

**Use Cases**:
- Webhook URLs in alert configurations
- API tokens in logs
- AWS access keys accidentally logged

---

### Audit Logging Infrastructure

Structured audit logging for security-sensitive operations:

**Audit Package** (`spawn/pkg/audit`):

**AuditLogger** - Structured JSON logging:
```go
logger := audit.NewLogger(os.Stderr, userID, correlationID)
logger.LogOperation("terminate_instances", sweepID, "success", nil)
```

**Context Propagation**:
```go
ctx = audit.NewContextWithAudit(ctx, userID)
logger := audit.NewLoggerFromContext(ctx)
```

**Audit Event Fields**:
- `timestamp`: UTC timestamp
- `level`: info/error
- `operation`: Action performed
- `user_id`: AWS account/user ID
- `instance_id`: Resource identifier
- `region`: AWS region
- `correlation_id`: Trace requests across systems
- `result`: success/failed/initiated
- `error`: Error message if failed
- `additional_data`: Structured metadata

**Ready for CloudWatch Logs Integration**:
- JSON format for CloudWatch Logs Insights
- Correlation IDs for distributed tracing
- User attribution for compliance

**Test Coverage**: audit paths are unit-tested; current coverage is reported by CI.

---

### Security Testing

**Test Suites**:
1. **Attack Pattern Tests** (`pkg/security/shell_test.go`):
   - Command injection: `; rm -rf /`, `$(whoami)`, backticks
   - Path traversal: `../../etc/passwd`
   - Variable expansion: `${IFS}malicious`

2. **Path Validation Tests** (`pkg/security/path_test.go`):
   - System directory blocking
   - Mount point restrictions
   - Traversal detection

3. **Audit Logger Tests** (`pkg/audit/logger_test.go`):
   - JSON formatting
   - Context propagation
   - Error logging

**Coverage Targets**: security and audit packages target ≥80% coverage, enforced
by a CI ratchet floor; current figures are shown by each repo's coverage badge.

---

### Vulnerability Reporting

**Security Contact**: scott@spore.host

**Please Report**:
- Command injection bypasses
- Path traversal attacks
- Credential exposure
- Privilege escalation
- Any security vulnerability

**Do NOT report via public GitHub issues**

Response time: 48 hours

---

## 11. Frequently Asked Questions (Security)

### Q: Can spawn access my existing EC2 instances?

**A:** No. spawn can only launch new instances and terminate instances tagged `spawn:managed=true`. It cannot access, modify, or terminate instances launched by other tools.

---

### Q: What data does spawn send to external services?

**A:** None. spawn only communicates with:
- AWS APIs (EC2, IAM, SSM)
- S3 buckets for spored binary download (public, read-only)

No telemetry, analytics, or user data leaves your AWS account.

---

### Q: Can spored access my S3 buckets or databases?

**A:** No. The `spored-instance-role` only has permissions for:
- Reading its own EC2 tags
- Terminating/stopping itself

It cannot access S3, RDS, DynamoDB, or any other AWS services.

---

### Q: What if someone modifies the spored binary on S3?

**A:** Both cases are covered. **Accidental corruption** (truncated download,
bit-rot) is caught by the SHA-256 check. **Malicious replacement by an attacker
with write access to the bucket** is caught by the **publisher signature**: each
spored binary is KMS-signed at release, and the bootstrap verifies the `.sig`
against a public key compiled into spawn before executing spored, failing closed
on a mismatch (spawn v0.91.1+, [#440](https://github.com/spore-host/spore-host/issues/440)).
Because the verifying key lives in the spawn binary (not the bucket), rewriting
the bucket can't forge a valid signature. See §4, *Binary Distribution Security*.

---

### Q: Can users extend or bypass TTL limits?

**A:** Users can extend the TTL of a running instance with `spawn extend <name> <duration>`. This updates the EC2 tag and spored picks up the new deadline live. They cannot remove the TTL entirely once set.

They could also:
- Manually terminate the instance and launch a new one (new TTL starts)
- SSH in and stop the spored service (instance won't auto-terminate)

**Mitigation:** CloudWatch Events rule to detect spored service failures.

---

### Q: How do I audit spawn usage?

**A:** Use CloudTrail:

```bash
# All spawn launches (last 7 days)
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceType,AttributeValue=AWS::EC2::Instance \
  --max-results 1000 \
  --query 'Events[?contains(CloudTrailEvent, `spawn:managed`)].{Time:EventTime,User:Username,Instance:Resources[0].ResourceName}'

# Cost by user (requires Cost Allocation Tags)
aws ce get-cost-and-usage \
  --time-period Start=2025-12-01,End=2025-12-31 \
  --granularity MONTHLY \
  --group-by Type=TAG,Key=spawn:created-by \
  --metrics BlendedCost
```

---

## 11. Contact and Support

**Security Issues:** Report to project maintainers (see CONTRIBUTING.md)

**Documentation:**
- IAM permissions reference: [docs/reference/iam-permissions.md](docs/reference/iam-permissions.md)
- Security, credentials & data flow: [docs/architecture.md](docs/architecture.md)
- Costs & safety guarantees: [docs/safety.md](docs/safety.md)

**Reporting a vulnerability:** please use the private
[GitHub Security Advisory](https://github.com/spore-host/spore-host/security/advisories/new)
rather than a public issue.

**References:**
- [AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [AWS Well-Architected Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)
- [CloudTrail Event Reference](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference.html)

---

This document tracks the current design; it is not pinned to a specific release.
Component behavior is versioned in each repo's `CHANGELOG.md`.
