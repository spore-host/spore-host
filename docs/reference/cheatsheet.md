# Cheat Sheet

Quick reference for common commands.

## truffle

```sh
# Find instances
truffle find "nvidia h100"
truffle find "t3 medium" --region us-east-1
truffle find "arm64 64gb" --spot --sort-by-price

# Spot prices
truffle spot g5.xlarge
truffle spot p4d.24xlarge --regions us-east-1,us-west-2

# Quota check
truffle quota --instance-type p4d.24xlarge --region us-east-1
truffle quota --instance-type g5.xlarge --spot

# Capacity reservations
truffle capacity --region us-east-1
```

## spawn — launch

```sh
spawn                                                  # interactive wizard
spawn launch --name my-job --instance-type g5.xlarge --ttl 8h
spawn launch --spot --ttl 12h --on-complete terminate
spawn launch --count 8 --mpi --ttl 6h                  # MPI cluster
spawn launch --active-processes rsession --ttl 8h       # RStudio
spawn launch --slack-workspace T03NE3GTY --ttl 4h       # with notifications
spawn launch --dry-run                                  # validate, don't launch
```

## spawn — manage

```sh
spawn list                          # running instances
spawn list --state all              # all states
spawn status my-instance            # detailed status
spawn extend my-instance 4h         # extend TTL
spawn stop my-instance              # stop (preserves instance)
spawn stop my-instance --hibernate  # hibernate
spawn start my-instance             # start stopped instance
spawn terminate my-instance         # terminate permanently
spawn connect my-instance           # get SSH command + URL
```

## spawn — defaults

```sh
spawn defaults set slack-workspace T03NE3GTY
spawn defaults set idle-timeout 1h
spawn defaults set active-processes rsession
spawn defaults list
spawn defaults unset active-processes
```

## spawn — bot

```sh
spawn bot workspace-add --platform slack --workspace-id T0... \
  --bot-token xoxb-... --signing-secret abc...
spawn bot register --platform slack --user you@lab.edu \
  --workspace-id T0... --instance i-0abc123 --nickname rstudio
spawn bot enable  --platform slack --user you@lab.edu \
  --workspace-id T0... --nickname rstudio
spawn bot disable --platform slack --user you@lab.edu \
  --workspace-id T0... --nickname rstudio
spawn bot status
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
lagotto deploy --region us-east-1
lagotto watch --instance-type p5.48xlarge --action notify --slack-workspace T0...
lagotto watch --instance-type p5.48xlarge --action launch --launch-name training
lagotto list
lagotto cancel <watch-id>
```

## Environment variables

```sh
AWS_PROFILE=my-profile spawn launch ...    # use specific AWS profile
AWS_REGION=us-west-2 spawn launch ...      # override region
SPORE_BOT_NOTIFY_URL=https://...           # custom notification Lambda URL
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
spawn sweep \
  --name hp-search \
  --instance-type g5.xlarge \
  --ttl 4h \
  --params "lr=0.001,0.01,0.1;batch=32,64,128" \
  --command "python train.py --lr {lr} --batch {batch}"
```
