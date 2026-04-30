# Lagotto

Lagotto watches for EC2 instance capacity and acts when it appears. It runs as a serverless Lambda function — no always-on server required. Configure a watch, deploy, and Lagotto polls on a schedule until capacity shows up.

## Install

```sh
brew install scttfrdmn/tap/lagotto
```

## The problem it solves

Some instance types — particularly high-demand GPU families like p5.48xlarge or trn1.32xlarge — have intermittent availability. You want the instance, but there's none available right now. Without Lagotto, your options are: keep trying manually, or write your own polling loop.

Lagotto automates the waiting.

## Core commands

### `lagotto watch`

Create a watch for an instance type in one or more regions:

```sh
# Watch for a p5.48xlarge and notify Slack when available
lagotto watch \
  --instance-type p5.48xlarge \
  --region us-east-1,us-west-2 \
  --action notify \
  --slack-workspace T03NE3GTY

# Watch and auto-launch when available
lagotto watch \
  --instance-type p5.48xlarge \
  --region us-east-1 \
  --action launch \
  --launch-name my-training \
  --launch-ttl 24h
```

### `lagotto list`

```sh
lagotto list        # all active watches
lagotto list --json # machine-readable
```

### `lagotto cancel`

```sh
lagotto cancel <watch-id>
lagotto cancel --all
```

## Actions

When capacity appears, Lagotto can:

| Action | What happens |
|--------|-------------|
| `notify` | Sends a Slack/Teams message with region and AZ |
| `launch` | Immediately launches the instance using your configured defaults |
| `webhook` | POSTs a JSON payload to a URL you specify |

## How it works

Lagotto deploys as an AWS Lambda function with an EventBridge schedule trigger. Each tick (configurable — default 5 minutes) it calls `DescribeInstanceTypeOfferings` for each watched type and region. When the type appears in an AZ, it fires the configured action and optionally cancels itself.

## Deploy

Lagotto deploys to your AWS account (the one you'll launch instances in):

```sh
lagotto deploy --region us-east-1
```

This creates the Lambda function, EventBridge rule, and IAM role needed to run the watches. The cost is negligible — well under $1/month for typical usage.

## Full command reference

→ [lagotto command reference](/tools/reference/lagotto)
