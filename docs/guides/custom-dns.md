---
description: "Every spore gets a DNS name under spore.host by default. You can register them under a domain of your own instead, through a DNS updater you run."
---

# Custom DNS: your own domain for instances

When an instance starts, spored registers a DNS name for it, so you can reach
it by name instead of by IP address. By default the name is under `spore.host`
and goes through spore.host's DNS updater. You can register names under a zone
you own instead, such as `spore.example.org`, through an updater you run.

This page covers the default naming, how to point launches at your own domain,
the permissions involved, and what custom DNS doesn't cover yet. Deploying the
updater itself is part of [Self-Hosting](/guides/self-hosting#step-2-deploy-the-dns-updater).
Custom DNS shipped in spawn **v0.130.0**.

## The default: `*.spore.host`

A spore named `web`, launched in account `123456789012`, is registered as:

```
web.1kpqzg2c.spore.host
```

- `web` is the `--name` (or `--dns`, if you set a different DNS name).
- `1kpqzg2c` is your account ID in base 36. Each account gets its own
  subdomain, and the updater only lets an account write records inside its own.
- `spore.host` is the zone.

spored registers the record itself, at boot. It renews a lease record beside it
(`_spore-lease.<record>`) about once an hour. When the instance terminates
cleanly, spored deletes its record.

```sh
spawn launch web --ttl 4h           # registers web.<account>.spore.host
spawn launch web --ttl 4h --no-dns  # registers nothing
spawn dns list                      # your spores' DNS names
```

`--no-dns` skips registration for one launch. To turn it off for every launch,
set `dns.enabled: false` in `~/.spawn/config.yaml`.

## Using your own domain

Custom DNS changes two things:
- the **domain**: the zone names are registered under;
- the **endpoint**: the updater that writes them.

The updater is a Lambda function with a Function URL. Someone has to deploy one
that serves your zone; see [Self-Hosting, step 2](/guides/self-hosting#step-2-deploy-the-dns-updater).
It prints the Function URL when it's done. Then point launches at it:

```sh
spawn launch web --ttl 4h --dns-domain spore.example.org --dns-api-endpoint https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/
```

The name becomes `web.1kpqzg2c.spore.example.org`.

spawn doesn't configure anything on the instance. It writes two tags beside
`spawn:dns-name`, and spored reads them at boot:

| Tag | Meaning |
|---|---|
| `spawn:dns-domain` | The zone to register under |
| `spawn:dns-endpoint` | The updater's Function URL |

Neither tag is written when you're using spore.host's defaults.

### Where the settings come from

Each of the two values is resolved on its own. The first source that has a value
wins:

| Source | Domain | Endpoint |
|---|---|---|
| Flag | `--dns-domain` | `--dns-api-endpoint` |
| Environment | `SPAWN_DNS_DOMAIN` | `SPAWN_DNS_API_ENDPOINT` |
| `~/.spawn/config.yaml` | `dns.domain` | `dns.api_endpoint` |
| SSM parameter, in the launch's account and region | `/spawn/dns/domain` | `/spawn/dns/api_endpoint` |
| Default | `spore.host` | spore.host's updater |

You can set just one of the two:
- **A domain alone** works when the updater you already use serves that zone.
- **An endpoint alone** sends registrations for `spore.host` names to that
  updater.

In `~/.spawn/config.yaml`:

```yaml
dns:
  domain: spore.example.org
  api_endpoint: https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/
```

### Set it once for an account: SSM parameters

An administrator can publish the settings in SSM Parameter Store, so everyone
launching in that account and region uses them without any flags:

```sh
aws ssm put-parameter --region us-east-1 --type String --name /spawn/dns/domain --value spore.example.org
aws ssm put-parameter --region us-east-1 --type String --name /spawn/dns/api_endpoint --value https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/
```

- The parameters are read **per region**: set them in every region people
  launch in.
- Use `String` parameters. spawn reads them without decryption, so a
  `SecureString` value arrives encrypted, fails validation, and the launch is
  refused.

::: warning If people can't read the parameters, DNS goes to spore.host
spawn treats **any** error reading `/spawn/dns/*` the same as the parameter
not existing. If someone's IAM policy lacks `ssm:GetParameter` on those paths,
their launches quietly fall back to the defaults: names under `spore.host`,
registered through spore.host's updater. Nothing in the output says so, except
that the launch preview shows no `under <your domain>` (see [below](#check-before-you-launch)).
This is [spawn#1121](https://github.com/spore-host/spawn/issues/1121), still open.

Until it's fixed:
- grant `ssm:GetParameter` on `/spawn/dns/*` to everyone who launches (see
  [Permissions](#permissions));
- or set the values somewhere that can't be skipped: the flags, the environment
  variables, or `~/.spawn/config.yaml`.
:::

### What is accepted

spawn checks both values before it launches anything, and refuses the launch
with the source of the bad value (for example `DNS domain from SSM /spawn/dns/domain: …`).

- **Domain:** a lowercase domain name with at least two labels, 253 characters
  at most. spawn can't check that the updater actually serves the zone; the
  updater answers `Unknown domain` when it doesn't.
- **Endpoint:** a bare Lambda Function URL, `https://<id>.lambda-url.<region>.on.aws/`.
  No path, query, port or credentials. Requests are SigV4-signed for Lambda in
  the region named in the hostname, so no other kind of endpoint can
  authenticate: not API Gateway, not a custom domain, not plain HTTP.

spored checks the tags again before using them. On a bad value it registers
nothing and sets `spawn:dns-status=failed` with the reason in `spawn:dns-error`.
It never falls back to spore.host.

### Check before you launch

`spawn launch --dry-run` resolves the target and shows it:

```
DNS:          web under spore.example.org
DNS updater:  https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/
```

With `-o json`, the preview has `dns_domain` and `dns_endpoint`. If the line says
just `DNS: web`, the launch will register under spore.host.

### Check after you launch

```sh
spawn launch dns-test --ttl 1h --dns-domain spore.example.org --dns-api-endpoint https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/
spawn dns list
spawn status dns-test
```

- `spawn launch` prints the FQDN once spored has registered it, or says
  registration hasn't happened yet.
- `spawn dns list` shows each instance's FQDN in the zone its own
  `spawn:dns-domain` tag names.
- `spawn status` prints a warning, with spored's reason, only when registration
  **failed**. It prints nothing about DNS when registration succeeded.

## Managing records by hand: `spawn dns`

```sh
spawn dns list                     # instances with a DNS name
spawn dns list --all               # every spawn instance, with or without one
spawn dns register web web2        # register another name for a running instance
spawn dns delete web --yes         # delete the instance's record, without the prompt
```

- `register <instance-id> <dns-name>` and `delete <instance-id>` take an instance
  ID or name. `register` needs the instance running with a public IP. Names may
  contain lowercase letters, digits and hyphens.
- Both act where the instance's own `spawn:dns-domain` and `spawn:dns-endpoint`
  tags say it registered. `--domain` and `--endpoint` override that; without
  the tags, they fall back to the chain [above](#where-the-settings-come-from).

## Permissions

| Who | Needs | When |
|---|---|---|
| Everyone who launches | `ssm:GetParameter` on `arn:aws:ssm:*:*:parameter/spawn/dns/*` | Whenever the account uses the SSM parameters; without it, DNS silently goes to spore.host. Part of the [IAM baseline](/reference/iam-permissions) |
| The administrator | `ssm:PutParameter` on the same paths | To publish the settings |
| The instance role | `lambda:InvokeFunctionUrl` on **your** updater function | See below |
| The updater | A resource policy granting each launch account `lambda:InvokeFunctionUrl` with `AuthType: AWS_IAM` | Set up by the deploy script's `--allow-account` |

The updater authorizes callers by the account their SigV4 signature proves,
which is why its Function URL must stay `AuthType: AWS_IAM` and must never be
public. The deploy script grants `lambda:InvokeFunctionUrl` only, never
`lambda:InvokeFunction`. A direct invocation would let the caller write the whole
request, including the account the updater trusts. How spore.host's own updater
decides who may register is described in spawn's
[dns-updater-authorization.md](https://github.com/spore-host/spawn/blob/main/docs/dns-updater-authorization.md).

::: warning The instance role and a self-hosted updater (spawn#1158)
The instance role spawn creates allows `lambda:InvokeFunctionUrl` only on
**spore.host's** updater function. When your updater runs in a *different*
account from the instances, which is the usual central-updater setup, AWS needs
an allow on both sides: the updater's resource policy *and* the caller's own IAM
policy. So it will likely refuse spored's requests, with
`spawn:dns-status=failed`, until the instance role is also allowed to call it.
(In the *same* account, the resource policy alone should be enough.) spawn
hasn't shown a self-hosted updater working end to end yet.

One way to add the grant is a policy file passed at launch. spawn attaches it
alongside its own baseline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "lambda:InvokeFunctionUrl",
      "Resource": "arn:aws:lambda:us-east-1:111122223333:function:spawn-dns-updater"
    }
  ]
}
```

```sh
spawn launch web --ttl 4h --iam-policy-file dns-invoke.json
```

Use your updater's region, account and function name.
:::

## Running your own updater

The updater lives in the spawn repository (`lambda/dns-updater`) and is deployed
with `scripts/deploy-custom-dns.sh`. The steps, flags and the account guard are
in [Self-Hosting, step 2](/guides/self-hosting#step-2-deploy-the-dns-updater).
The most important one: set `SPAWN_LAMBDA_ACCOUNT` to your own account. Without
it, the script targets spore.host's infrastructure account, where it adds your
zone to spore.host's updater instead of deploying yours.

Run against an updater that already serves other zones, the script is additive:
it adds the new zone and any new accounts, and widens the Route 53 grant to
cover every zone served. The default zone and the existing accounts are left
alone.

## What it doesn't cover yet

- **Some launch paths always use spore.host.** `spawn launch` resolves the
  custom target, including `--count` arrays and `--mpi` clusters. The batch
  queue, parameter sweeps and `spawn burst` don't, and register under
  `spore.host`.
- **Records left behind need a reaper that knows your zone.** An instance that
  terminates cleanly deletes its own record. One that dies without doing so (a
  crash, a terminate from outside spawn) leaves it. Only the TTL reaper removes
  those, and only in the zones it's been told about: its `DnsZoneId`, plus any
  in `DnsExtraZoneIds`. Add your zone's hosted zone ID there, or run your own
  reaper with your zone as `DnsZoneId`; the details are in spawn's
  [custom-dns.md](https://github.com/spore-host/spawn/blob/main/docs/custom-dns.md#limits).
  Until then, remove stale records with `spawn dns delete`.
- **DNSSEC** for your zone is up to you: spawn and the updater only write
  A records.

## See also

- [Self-Hosting](/guides/self-hosting): deploying the updater and the rest of the
  infrastructure.
- [IAM Permissions](/reference/iam-permissions): the baseline, including
  `ssm:GetParameter` on `/spawn/dns/*`.
- spawn's [custom-dns.md](https://github.com/spore-host/spawn/blob/main/docs/custom-dns.md):
  the design and the operator details.
