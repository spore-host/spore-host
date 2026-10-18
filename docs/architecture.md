---
description: "Where your credentials stay, what calls AWS, and what runs where — a plain map of spore.host's trust and data-flow model."
---

# Security, credentials & data flow

The name is *spore.host*, but spore.host is **not** the host. It never holds your
AWS credentials and never runs your compute. Everything runs on **your own AWS
account**, using **your own credentials**. This page maps exactly what runs where,
so you can answer the questions a cautious researcher — or their security team —
will ask before running it.

## What runs where

```
┌─ Your computer ────────────────────────────────────────────┐
│  truffle   queries AWS for instance metadata, prices, quotas │
│  spawn     calls AWS APIs to launch and provision instances  │
│            (uses your existing AWS credential chain)         │
└──────────────────────────────┬──────────────────────────────┘
                               │  AWS API calls, signed with
                               │  YOUR credentials
                               ▼
┌─ AWS — your account ───────────────────────────────────────┐
│  EC2 instance                                                │
│    spored   monitors TTL, idle, completion, cost             │
│             reads its rules from the instance's EC2 tags     │
│             ├─ stop / hibernate / terminate                  │
│             └─ emits lifecycle events                         │
└──────────────────────────────┬──────────────────────────────┘
                               │  event callbacks (no credentials)
                               ▼
┌─ spore.host-infra account (optional) ──────────────────────┐
│  Lambdas   route Slack/Teams messages, DNS, notifications    │
│            assume ONLY the narrow cross-account role you      │
│            grant — never hold your keys                       │
└─────────────────────────────────────────────────────────────┘
```

## The questions this answers

**Where do my credentials stay?**
On your machine, in your normal AWS credential chain (`~/.aws/credentials`,
environment variables, SSO, or instance metadata). truffle and spawn read them the
same way the AWS CLI does. spore.host never stores, transmits, or sees them.

**Must my laptop stay open?**
No. Once spawn launches an instance, **spored** takes over lifecycle enforcement
from *inside* the instance. It reads its rules from the instance's EC2 tags every
minute, so the TTL and idle rules keep working after you disconnect, close your
laptop, or lose your network. See [How it works](/how-it-works).

**Who actually terminates the machine?**
spored, running on the instance itself — not your laptop, not a spore.host server.
An out-of-band reaper is the backstop if spored can't; see
[Costs & safety guarantees](/safety).

**Is there a central control plane that runs my compute?**
No. The only hosted components are optional Lambda functions (chat control, DNS,
notifications) in the spore.host-infra account. They never run your workloads and
never hold your credentials — for chat control they **assume a narrow
cross-account IAM role you explicitly create**, scoped to specific EC2 actions.
You can run entirely without them (`lagotto poll --daemon`, no chat integration),
in which case nothing leaves your account at all.

**What metadata leaves my account?**
Only what you opt into. If you enable Slack/Teams or hosted notifications, spored
sends lifecycle *events* (instance nickname, state, TTL countdown — no
credentials, no data from the instance) to the notification Lambda so it can DM
you. With no integrations enabled, nothing leaves your account.

**Does the HTTP API change this?**
Yes. The [Python SDK](/guides/python-sdk) talks to a beta HTTP API that
authenticates with a spore.host API key, not your AWS credentials, and runs in a
single AWS account: instances it launches run in the account hosting the API,
scoped to your key's project. That's a different trust model from the CLIs,
which act in your own account with your own credentials. Direct HTTP use isn't
a supported public interface yet.

## How to audit everything it creates

Every resource spore.host creates is tagged. To see exactly what it owns:

```sh
# Every instance spawn is managing, with its lifecycle tags
spawn list

# Raw: all spawn:* tags on a specific instance
aws ec2 describe-tags \
  --filters "Name=resource-id,Values=i-0abc123def456xyz" \
  --query 'Tags[?starts_with(Key, `spawn:`)]' --output table
```

The full tag vocabulary is documented in [EC2 Tags](/reference/ec2-tags), the
exact IAM permissions in [IAM Permissions](/reference/iam-permissions), and the
env vars that point the tools at hosted vs. self-hosted infrastructure in
[Environment Variables](/reference/environment-variables).

## What spore.host doesn't do

- It doesn't take over SSH-key management. spawn imports your existing default
  public key (`~/.ssh/id_ed25519` or `~/.ssh/id_rsa`) into EC2 and connects you as
  a user matching your local login; only if you have no default key does it
  generate and manage one under `~/.spawn/keys/`. It never reads, moves, or uploads
  your private keys.
- It doesn't modify your AWS account structure, VPCs, or security groups beyond
  what's needed to launch.
- It doesn't store your AWS credentials — everything uses your existing chain.
- It doesn't require always-on infrastructure in your account. spored runs on the
  instance; the optional Lambdas run in the spore.host-infra account (or your own,
  if you [self-host](/guides/self-hosting)).

## Next steps

- **[Costs & safety guarantees](/safety)** — the auto-terminate promise and its failure boundaries
- **[IAM Permissions](/reference/iam-permissions)** — the minimal least-privilege policy
- **[Self-Hosting](/guides/self-hosting)** — run the Lambdas in your own account
