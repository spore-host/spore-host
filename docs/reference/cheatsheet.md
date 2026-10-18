---
description: "Quick reference for common commands."
---

# Cheat Sheet

Quick reference for common commands.

## truffle

```sh
# Find instances
truffle find "nvidia h100"
truffle find "t3 medium" --regions us-east-1
truffle find "arm64 64gb"

# Spot prices
truffle spot g5.xlarge
truffle spot p4d.24xlarge --regions us-east-1,us-west-2 --sort-by-price

# Quota check
truffle quotas --regions us-east-1 --family P
truffle quotas --regions us-east-1,us-west-2

# Capacity reservations
truffle capacity --gpu-only
truffle capacity --available-only
```

## spawn — launch

```sh
spawn                                                  # interactive wizard
spawn launch --name my-job --instance-type g5.xlarge --ttl 8h
spawn launch --spot --ttl 12h --on-complete terminate
spawn launch --count 8 --mpi --job-array-name sim --mpi-command './sim' --ttl 6h  # MPI cluster
spawn launch --active-processes rsession --ttl 8h       # RStudio
spawn launch --slack-workspace T03NE3GTY --ttl 4h       # with notifications
spawn launch --name big-disk --instance-type m7i.large --volume-size 200  # 200 GiB root
spawn launch my-job --instance-type c6a.large -o json | jq -r '.[0].instance_id'  # scriptable
```

## spawn — manage

```sh
spawn list                          # running instances
spawn list --state running          # filter by state
spawn status my-instance            # detailed status
spawn extend my-instance 4h         # extend TTL
spawn stop my-instance              # stop (preserves instance)
spawn hibernate my-instance         # hibernate (saves RAM to disk)
spawn start my-instance             # start stopped instance
spawn terminate my-instance         # permanently terminate (destroys EBS)
spawn terminate my-instance -y      # skip confirmation
spawn connect my-instance           # SSH in
```

## spawn — defaults

```sh
spawn defaults set slack-workspace T03NE3GTY
spawn defaults set idle-timeout 1h
spawn defaults set active-processes rsession
spawn defaults list
spawn defaults unset active-processes
```

## spawn — notify

```sh
spawn notify workspace-add --platform slack --workspace-id T0... \
  --bot-token xoxb-... --signing-secret abc...
spawn notify register --platform slack --user you@lab.edu \
  --workspace-id T0... --instance i-0abc123 --nickname rstudio
spawn notify enable  --platform slack --user you@lab.edu \
  --workspace-id T0... --nickname rstudio
spawn notify disable --platform slack --user you@lab.edu \
  --workspace-id T0... --nickname rstudio
spawn notify list --platform slack --workspace-id T0...
```

## Slack commands

```
/spore list
/spore status rstudio
/spore start rstudio
/spore stop rstudio
/spore hibernate rstudio
/spore extend rstudio 4h
/spore url rstudio
/spore notify rstudio
/spore unnotify rstudio
/spore connect
/spore help
```

## lagotto

```sh
# Watch for capacity, act when it appears
lagotto watch "p5.48xlarge" --action notify
lagotto watch "p5.48xlarge" --regions us-east-1 --action notify \
  --notify email:you@example.com
lagotto watch "g5.xlarge" --action spawn --spawn-config job.yaml
lagotto watch "g5.xlarge" --action spawn --spawn-config job.yaml --project fieldwork
lagotto list
lagotto status <watch-id>
lagotto cancel <watch-id>
lagotto extend <watch-id> --ttl 7d
lagotto history

# Schedule a launch by time (requires `lagotto deploy` first)
lagotto launch --at 2026-07-01T08:00:00Z --az us-east-1a --spawn-config block.yaml
lagotto launch --after 6h --spawn-config job.yaml
lagotto launch --cron "0 9 ? * MON-FRI *" --spawn-config nightly.yaml

# Poll: one cycle, or an infra-free daemon (scope it in a shared account)
lagotto poll
lagotto poll --daemon --interval 5m --project fieldwork
lagotto poll --daemon --mine

# Deploy / remove the hosted poller stack in your account
lagotto deploy
lagotto deploy --teardown
```

## Capacity Blocks for ML (truffle → spawn → lagotto)

```sh
# 1. Find a purchasable offering (read-only)
truffle capacity-blocks --instance-type p5.48xlarge --count 1 --duration-hours 24
# 2. Purchase it (up-front, non-refundable; three typed confirmations, interactive only)
spawn capacity-block purchase <offering-id> --instance-type p5.48xlarge \
  --count 1 --duration-hours 24 --region us-east-1 --dry-run   # preview; drop --dry-run to buy
# 3. Launch into it at the reserved start time (block.yaml sets reservation_id + capacity_block)
lagotto launch --at <block-start> --az <block-az> --spawn-config block.yaml
```

## Environment variables

```sh
AWS_PROFILE=my-profile spawn launch ...    # use specific AWS profile
AWS_REGION=us-west-2 spawn launch ...      # override region
SPORE_NOTIFY_URL=https://...               # custom notification Lambda URL
SPORED_TAG_PREFIX=prism                    # use custom EC2 tag prefix
```

## Common flag combinations

```sh
# Long-running training job with checkpoint on interruption
spawn launch --name training \
  --instance-type p4d.24xlarge --spot \
  --ttl 24h \
  --pre-stop "python save_checkpoint.py" \
  --on-complete terminate \
  --slack-workspace T03NE3GTY

# Interactive RStudio session
spawn launch --name rstudio \
  --instance-type r6i.4xlarge \
  --ttl 8h \
  --idle-timeout 2h \
  --active-processes rsession \
  --hibernate-on-idle

# GPU parameter sweep
spawn launch hp-search \
  --instance-type g5.xlarge \
  --ttl 4h \
  --param-file params.yaml \
  --command 'python train.py --lr $PARAM_lr --batch $PARAM_batch'   # params arrive as $PARAM_<key>
```
