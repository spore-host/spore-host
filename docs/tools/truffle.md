# Truffle

Truffle finds and compares EC2 instance types. It's read-only — it never launches anything. Use it to research what's available before committing to a launch.

## Install

```sh
brew install spore-host/tap/truffle
```

## Core commands

### `truffle find`

Search for instance types using plain language or filters:

```sh
truffle find "nvidia h100"
truffle find "arm64 64gb memory"
truffle find "cheap gpu" --spot --sort-by-price
truffle find "t3" --region us-east-1
```

Plain language works — truffle understands GPU model names, processor vendors, size descriptions, and network requirements. See [truffle find reference](/tools/reference/truffle#find) for all options.

### `truffle spot`

Get current Spot prices for a specific instance type:

```sh
truffle spot p4d.24xlarge
truffle spot g5.2xlarge --regions us-east-1,us-west-2,eu-west-1
```

### `truffle quota`

Check your service quotas before launching:

```sh
truffle quota --instance-type p4d.24xlarge --region us-east-1
truffle quota --instance-type g5.xlarge --spot
```

Returns current quota, current usage, and whether a launch would be allowed.

### `truffle capacity`

Check On-Demand Capacity Reservations (ODCRs) in your account:

```sh
truffle capacity --region us-east-1
truffle capacity --instance-type p4d.24xlarge
```

## Piping to spawn

Truffle's output can be piped to spawn:

```sh
truffle find "t3.medium" --pick-first | spawn launch --ttl 4h
truffle spot g5.xlarge --cheapest | spawn launch --name training --ttl 8h
```

## Full command reference

→ [truffle command reference](/tools/reference/truffle)
