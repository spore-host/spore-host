---
description: "Illustrative, annotated terminal sessions for spore.host — a passing preflight, a blocked one, a protected launch, lifecycle verification, and cleanup."
---

# Worked transcripts

These terminal sessions show the shape of a spore.host session — including a
failure — so you know what success and trouble look like before you run
anything. They follow the same arc as [Your First Instance](/guides/first-instance);
here the focus is the output.

The transcripts are **illustrative**, not captured from a real run. Values (IDs,
prices, IPs, versions) are made up, and the exact lines, check names, and their
order differ from what your version of `spawn` prints. Read them for what each
step tells you, then run the commands yourself to see the real output.

## 1. Preflight passes

`spawn doctor` is read-only — it never launches anything. When it passes, the
Quick Start should work as written.

```console
$ spawn doctor
✓ spawn version: v0.91.1
✓ truffle installed: v0.46.0
✓ AWS CLI available: aws-cli/2.32.0
✓ AWS credentials: arn:aws:iam::123456789012:user/researcher
✓ account: 123456789012
✓ region: us-east-1
✓ EC2 describe permission
✓ EC2 launch permission
✓ IAM instance-profile permission
✓ VPC & subnet: vpc-0a1b2c3d (subnet-04e5f6a7)
✓ SSH key: ~/.ssh/id_ed25519 (imported to EC2)
✓ Session Manager
⚠ TTL reaper backstop: not detected from this account (in-instance spored still enforces TTL)
⚠ Route 53 (DNS): Route 53 access unavailable; --dns subdomains won't work (optional)

12 passed, 2 warning(s), 0 failed

Ready to launch. If this passes, the Quick Start should work as written.
```

The two warnings are expected and non-blocking: the out-of-band reaper isn't
visible from your account (spored still enforces the TTL on the instance), and
Route 53 is only needed for the optional `--dns` feature.

## 2. Preflight blocked by a missing IAM permission

On an institution-managed account you may authenticate fine but lack permission to
launch. `spawn doctor` shows exactly what's missing and how to fix it:

```console
$ spawn doctor
✓ spawn version: v0.91.1
✓ truffle installed: v0.46.0
✓ AWS CLI available: aws-cli/2.32.0
✓ AWS credentials: arn:aws:iam::123456789012:role/ResearcherReadOnly
✓ account: 123456789012
✓ region: us-east-1
✓ EC2 describe permission
✗ EC2 launch permission: UnauthorizedOperation: not authorized to perform ec2:RunInstances
    → grant ec2:RunInstances (see the IAM baseline)
✗ IAM instance-profile permission: AccessDenied: not authorized to perform iam:PassRole
    → grant iam:* on spored* + iam:PassRole (see the IAM baseline)
✓ VPC & subnet: vpc-0a1b2c3d (subnet-04e5f6a7)
✓ SSH key: ~/.ssh/id_ed25519 (imported to EC2)
✓ Session Manager

10 passed, 0 warning(s), 2 failed

Not ready — resolve the ✗ items above before launching. If you're on an
institution-managed account, send the IAM baseline to your cloud administrator.
```

Nothing was launched. The fix is to grant the two permissions (or send the
[deployment packet](/reference/deployment-packet) and
[IAM baseline](/reference/iam-permissions) to your administrator) and re-run
`spawn doctor` until it's clean.

## 3. A protected launch

With a clean preflight, launch with a hard lifetime. The instance provisions
[spored](/tools/spored), which enforces the TTL and idle rules from inside:

```console
$ spawn launch analysis --instance-type m8a.4xlarge --ttl 8h --idle-timeout 30m
→ Resolving AMI (Amazon Linux 2023, x86_64)… ami-0b787142aa56d54db
→ Launching m8a.4xlarge in us-east-1… i-0abc123def4567890
→ Provisioning spored (TTL 8h, idle 30m)…
✓ Signature verified (spore.host)
✓ spored active — instance manages its own lifecycle
✓ Instance ready: analysis (i-0abc123def4567890) at 54.80.0.1

Connect:   spawn connect analysis
Terminate: spawn terminate analysis
```

## 4. Verify the protection is live

You don't have to take it on faith — `spawn status` shows the countdown and the
protection posture:

```console
$ spawn status analysis
spored: v0.91.1
State:  running
TTL:    7h 52m remaining
Idle:   30m timeout (no activity yet)

Lifecycle protection:
  In-instance (spored):  enforces TTL + idle rules on the instance itself
  Out-of-band reaper:    backstop in the spore.host-infra account, if deployed for your account
  Termination deadline:  2026-07-22 18:00 PDT (in 7h 52m)
  Max compute cost:      ~$6.16 by deadline (on-demand rate, compute only; idle-stop usually ends it sooner)
  Idle timeout:          30m (stops the instance when idle; never terminates)
```

The **Max compute cost** is a ceiling — the idle timeout usually stops the
instance well before the deadline.

## 5. Terminate and confirm cleanup

`spawn terminate` destroys the instance and its EBS volume (unlike `spawn stop`,
which leaves storage billing). Verify nothing is left:

```console
$ spawn terminate analysis
→ Terminating analysis (i-0abc123def4567890)…
✓ Terminated. EBS volume vol-0a1b2c3d4e5f deleted.

$ spawn list
No spawn instances found
```

If `spawn list` still shows the instance as `shutting-down`, give it a few seconds
and re-run — termination is asynchronous. A `terminated` or empty result means
you're no longer billed for compute or storage.

## See also

- [Your First Instance](/guides/first-instance) — the same flow, step by step
- [Costs & safety guarantees](/safety) — what the TTL/idle/cost rules guarantee
- [Troubleshooting & common mistakes](/reference/troubleshooting)
