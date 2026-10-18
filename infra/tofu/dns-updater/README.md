# dns-updater — OpenTofu module

Reconciles the hand-deployed **`spawn-dns-updater`** Lambda (the Route53 record
updater instances call to register their DNS) and its execution role under
OpenTofu, following the `spore-bot` module's import-onto-live pattern.

This is **step 0** of the spawn#173 cutover, which moves the DNS updater off the
spoofable EC2 instance-identity-document auth and onto the Function URL's
`AuthType: AWS_IAM`. Codifying the resource first makes the later grant + the
AuthType flip reviewable IaC changes instead of console edits.

## What it manages

- `aws_iam_role.dns_updater` — **`SpawnDNSLambdaExecutionRole`** + its two inline
  policies (`EC2DescribePolicy`, `Route53DNSUpdate`) and the basic-execution
  attachment.
- `aws_lambda_function.dns_updater` — the function **shape** (role, runtime,
  x86_64, memory, timeout).
- `aws_lambda_function_url.dns_updater` + the public invoke permission — the
  Function URL instances POST to (`zqonqra6…lambda-url.us-east-1.on.aws`),
  deterministic from function name + account + region, so it is preserved across
  the import.

## What it deliberately does NOT manage

- **Function code** — deployed out-of-band via `spawn/scripts/deploy-custom-dns.sh`.
  Tofu `ignore_changes` covers all code attributes so a deploy is never reverted.
- **Environment variables** — `DOMAIN_ZONES` (domain→hosted-zone map) is managed
  out-of-band; Tofu ignores `environment` so it isn't clobbered.

## State

Remote, in the infra account's state bucket (`dns-updater/terraform.tfstate`),
locked with an S3 lock file (#580). **No state has been written for this root
yet**: import its resources before the first `plan` (see the import runbook
here and [`../README.md`](../README.md)). Never commit state.

## How it was imported (runbook)

```sh
eval "$(aws configure export-credentials --profile spore-host-infra --format env)"
unset AWS_PROFILE; export AWS_REGION=us-east-1   # see ../README.md
tofu init
tofu import aws_iam_role.dns_updater SpawnDNSLambdaExecutionRole
tofu import 'aws_iam_role_policy_attachment.basic_execution' 'SpawnDNSLambdaExecutionRole/arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
tofu import aws_iam_role_policy.ec2_describe 'SpawnDNSLambdaExecutionRole:EC2DescribePolicy'
tofu import aws_iam_role_policy.route53 'SpawnDNSLambdaExecutionRole:Route53DNSUpdate'
tofu import aws_lambda_function.dns_updater spawn-dns-updater
tofu import aws_lambda_function_url.dns_updater spawn-dns-updater
tofu import aws_lambda_permission.url_public 'spawn-dns-updater/FunctionURLAllowPublicAccess'
tofu plan   # expect: 0 to add, 2 to change, 0 to destroy — only additive
            # managedby tags + the benign publish=false provider default
tofu apply
```

## The #173 cutover (why each step is ordered this way)

The DNS updater today accepts an attacker-controllable instance-identity document
and **default-allows cross-account callers** (its `DescribeInstances` check always
errors cross-account and returns ALLOW), so an unauthenticated caller can
UPSERT/DELETE arbitrary records. The fix is `AuthType: AWS_IAM`, where the Lambda
gets the **SigV4-verified caller account** on every request.

**Scaling decision — no account enumeration.** spawn launches instances in
arbitrarily many user accounts whose spored roles are dynamically named
(`spawn-instance-<hash>`). Enumerating principals in the function's resource
policy would mean per-account infra enrollment and a hard ~20KB policy ceiling.
Instead, security comes from three layers that need **zero** allow-list upkeep:

1. **`AuthType: AWS_IAM`** — every caller must present valid SigV4. The resource
   policy uses `Principal: "*"`, meaning "any signed AWS principal", not anonymous.
2. **Caller self-grant** — the spored instance role grants *itself*
   `lambda:InvokeFunctionUrl` on this function in its own identity policy
   (`spawn/pkg/aws/iam.go`), so access is controlled per-account with no
   infra-side action when a new account starts launching.
3. **Lambda verified-account namespacing** — the handler reads the verified
   caller account from `requestContext.authorizer.iam` and only permits writes
   under `base36(verifiedAccountID).<domain>`. This closes the cross-account
   spoofing cryptographically, with no per-region certs to maintain (the reason
   IAM auth was chosen over the PKCS#7 identity-doc path; see #294).

Execution order (each step gated; the flip is destructive):

| # | Where | Action | Status |
|---|-------|--------|--------|
| 0 | here | Import the resource under tofu (this module). | ✅ done |
| 2 | spawn | Client SigV4-signs (PR #242, gated `SPORE_DNS_SIGV4`). | ✅ shipped |
| — | spawn | **Enabler:** spored sets `SPORE_DNS_SIGV4=1` (v0.67.0+). | ✅ shipped |
| 3 | spawn | IAM-aware handler (verified-account namespacing), deployed to the live fn. | ✅ deployed |
| 1+3 | here | `enable_iam_invoke = true` → flip `authorization_type` to `AWS_IAM` (lockstep) + add the `Principal:"*"` invoke grant, remove the NONE public grant. | ✅ **done 2026-06-25** |
| 4 | spawn | Delete the legacy identity-doc parsing / `signature.go` / embedded certs / cross-account default-allow. | ⏳ post-cutover cleanup (dual-path handler serves both until then) |

**The flip (now done) was lockstep with a signing fleet:** spored has signed
since v0.67.0, the IAM-aware handler was deployed, and there were no live
non-signing instances. `enable_iam_invoke` is now the committed default (`true`).
Verified post-flip: an unsigned POST returns `403 {"Message":"Forbidden"}` from
the URL auth layer (the vuln is closed), and a SigV4-signed call reaches the
handler and is namespaced to the verified caller account. Rollback if ever
needed: `tofu apply -var enable_iam_invoke=false` (AuthType ← NONE, seconds).

## Day-to-day

- Change role/permissions/function shape here → `tofu plan` → `tofu apply`.
- Ship new code: `cd spawn && scripts/deploy-custom-dns.sh` (unchanged).
- `tofu plan` should stay clean; a non-tag diff means out-of-band drift worth
  investigating.
