---
description: "Everything a cloud/security administrator needs to approve spore.host for a researcher on an institution-managed AWS account — in one page."
---

# Deployment packet (for AWS administrators)

A researcher on your team wants to use **spore.host** to launch short-lived,
self-terminating EC2 instances in your AWS account. This page is the one thing
they need to hand you: what it is, exactly what permissions it needs and why,
what it creates, what it audits, what (if anything) leaves the account, and how to
remove it.

**One-line summary:** spore.host is a set of CLI tools that run on the
researcher's machine with *their* AWS credentials and launch EC2 in *your*
account. It never receives your credentials or workload data. Its whole purpose is
to bound cost — every instance gets a hard termination deadline. See
[Security, credentials & data flow](/architecture) for the full trust map and
[Security Overview](https://github.com/spore-host/spore-host/blob/main/SECURITY.md)
for the CISO-oriented assessment.

## 1. The least-privilege policy to grant

The complete baseline policy, with each action traced to the spawn code that
calls it, is on the
**[IAM Permissions](/reference/iam-permissions)** page — apply that policy to the
IAM role/user the researcher authenticates as. It grants:

- **EC2** describe + `RunInstances` + tag + start/stop/terminate (the last three
  **conditioned on `spawn:managed=true`**, so it can only act on instances spawn
  created — never anything else in the account).
- **EC2** `ImportKeyPair`, `CreateSecurityGroup`, `AuthorizeSecurityGroupIngress`
  (to install the user's SSH key, and for the launches that need a security group).
- **IAM** create-role / instance-profile / tag / `PassRole` **scoped to `spored*`
  and `spawn-instance-*` names only**, so it cannot create or touch any other role.
- **SSM** `GetParameter`, only on AWS's public AMI parameters and the account's
  `/spawn/dns/*` settings.

Optional feature permissions (the first Spot launch in an account, the
`spawn dns` commands, FSx) are listed separately on that page and are only
needed if the researcher uses those features.

## 2. What spawn creates in your account

| Resource | When | Notes |
|----------|------|-------|
| `spored-instance-role` + `spored-instance-profile` | Once per account, on first launch | Scoped so the instance can read its own tags and stop/terminate itself only |
| `spawn-instance-<hash>` role + profile | Per distinct set of extra instance permissions (`--iam-policy`, `--s3-read`/`--s3-write`, `spawn task run`) | Reused across launches with the same permissions; **not** removed automatically |
| EC2 instances | Per `spawn launch` | Tagged `spawn:managed=true`, `spawn:ttl`, `spawn:created-by=spawn`, etc.; terminate at their TTL |
| A security group | Only for MPI, Windows, DCV desktop and web-app launches | Opens the ports that kind of launch needs, to `0.0.0.0/0` by default (for Windows, `--allow-cidr` narrows it). An ordinary Linux launch creates none and uses the default VPC's group |
| An imported EC2 key pair | Per user | The researcher's **public** key only |
| `spawn-results-<account>-<region>` S3 bucket | First `spawn task run` in a region | Task completion records and logs |

The roles, profiles, key pairs and results buckets persist. Instances terminate on
their own. `spawn footprint` lists everything spawn has created in an account.

## 3. What it audits

Every action spawn takes is a normal AWS API call by the researcher's identity,
so it all lands in **CloudTrail** under their principal: `RunInstances`,
`TerminateInstances`, `CreateRole`/`CreateInstanceProfile` (first launch),
`ImportKeyPair`, `CreateSecurityGroup`, and the tagging calls. You can build a
Cost Allocation report from the `spawn:*` tags. See the
[Security Overview](https://github.com/spore-host/spore-host/blob/main/SECURITY.md#5-audit-and-compliance)
for example CloudTrail queries.

## 4. What leaves the account

Credentials and workload data never leave the account. The CLI and the
in-instance `spored` daemon run within your account. Two things do call out to
spore.host's own AWS account over HTTPS:

- **DNS names, on by default for named instances.** A launch with `--name`
  registers `<name>.<account-label>.spore.host`: spored sends the name, the
  instance's public IP and (through the request signature) the account ID to
  spore.host's DNS updater. Use `--no-dns` per launch, set `dns.enabled: false`,
  or point launches at [your own updater](/guides/self-hosting).
- **Chat notifications (Slack/Teams/Discord), only if the researcher enables
  them.** They send selected metadata: instance ID, state and tags.

Both can be [self-hosted](/guides/self-hosting) so nothing leaves the account at all. See the
["guarantee by deployment mode" table](https://github.com/spore-host/spore-host/blob/main/SECURITY.md#lifecycle-guarantee-by-deployment-mode).

## 5. Cost-safety posture (why this reduces risk)

spore.host exists to prevent forgotten instances. Every launch has a **TTL** — a
hard deadline enforced from inside the instance by `spored`, independent of the
researcher's laptop. You can additionally require budgets/SCPs as usual; spore.host
complements them. See [Costs & safety guarantees](/safety).

## 6. Predeployment validation

Before (and after) you grant the policy, the researcher can run:

```sh
spawn doctor
```

It performs read-only checks: credentials and account, EC2 describe and launch
permissions, the IAM instance-profile permissions, the spored role, VPC and
subnet, Session Manager, TTL-reaper coverage and Route 53. Each failure comes
with a fix, so you can confirm the grant without launching anything. It checks
categories of permission, not every action on the IAM page, so treat an
all-clear as "ready to try a launch", not as proof of the full policy.

## 7. Removal / cleanup

To fully remove spore.host's footprint:

```sh
# 1. See everything spawn has created in this account
spawn footprint

# 2. Terminate any managed instances (there's no "terminate everything" flag)
aws ec2 describe-instances \
  --filters Name=tag:spawn:managed,Values=true Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].InstanceId' --output text
aws ec2 terminate-instances --instance-ids <ids from above>

# 3. Delete spawn's roles and instance profiles. A role can't be deleted while it
#    has policies or is in a profile, so empty each one first.
for role in $(aws iam list-roles --query "Roles[?starts_with(RoleName,'spored') || starts_with(RoleName,'spawn-instance-')].RoleName" --output text); do
  for p in $(aws iam list-role-policies --role-name "$role" --query PolicyNames --output text); do
    aws iam delete-role-policy --role-name "$role" --policy-name "$p"
  done
  for a in $(aws iam list-attached-role-policies --role-name "$role" --query 'AttachedPolicies[].PolicyArn' --output text); do
    aws iam detach-role-policy --role-name "$role" --policy-arn "$a"
  done
  for ip in $(aws iam list-instance-profiles-for-role --role-name "$role" --query 'InstanceProfiles[].InstanceProfileName' --output text); do
    aws iam remove-role-from-instance-profile --instance-profile-name "$ip" --role-name "$role"
    aws iam delete-instance-profile --instance-profile-name "$ip"
  done
  aws iam delete-role --role-name "$role"
done
```

Results buckets (`spawn-results-<account>-<region>`) and imported key pairs are
listed by `spawn footprint`; delete them if you no longer need them.

Detach the least-privilege policy from the researcher's identity to revoke access.
`spawn orphans` / `spawn cleanup` (run by the researcher) find and remove leftover
volumes, security groups and other per-launch resources.

---

**Questions?** The [Security Overview](https://github.com/spore-host/spore-host/blob/main/SECURITY.md)
answers most security-team questions; for anything else, reach the maintainers via
[Discord](https://discord.gg/2deGRFCW) or a
[private security advisory](https://github.com/spore-host/spore-host/security/advisories/new).
