#!/usr/bin/env bash
#
# One-off: tag spore.host's live service resources in the infra account
# (966362334030) spore-host:role=service, spore-host:component=<id> and
# spore-host:deployed-by=<path> (#750, epic #752).
#
# Why. Most of the infra account's service resources carry spawn:managed=true,
# which is also the tag spawn puts on workload litter. In the #749 sweep a litter
# classifier marked 12 live resources as litter (spawn-websocket-connections,
# spore-api-keys, spore-bot-registry, spore-sms-pending, scheduler-handler, the
# spawn-schedules-* buckets, ...). Every deploy path now adds the three tags
# (spore-host/spawn and this repo, #750). This script covers what those deploy
# paths do not reach:
#
#   - resources built by hand, which no deploy path will ever tag
#     (spore-rest-api, its role and tables, spawn-ws-tickets, the spore-bot
#     tables, the hourly cost-history rule, the infra account's lagotto tables);
#   - resources whose deploy path tags only on create, so an existing one stays
#     untagged until someone reruns a setup script that also rewrites IAM
#     policies (the tables, roles, buckets and APIs);
#   - the functions and log groups, so the account is labelled before every
#     component has been redeployed.
#
# Each row writes exactly the values the resource's own deploy path writes, so a
# later deploy changes nothing. A resource no deploy path builds names this
# script as its spore-host:deployed-by, the only record of it.
#
# Every write MERGES: tag-resource / tag-role add keys and leave the others
# alone, and a bucket's tag set (which put-bucket-tagging replaces whole) is read
# first and written back with the three keys added. A bucket whose tags cannot be
# read is not written.
#
# Usage:
#   scripts/retag-service-resources.sh --profile spore-host-infra           # dry run: before/after table
#   scripts/retag-service-resources.sh --profile spore-host-infra --apply   # write, then re-read
#
# Refuses unless `sts get-caller-identity` for --profile is 966362334030. Makes
# no other AWS call before that check. Read-only without --apply.
#
# Needs: aws CLI v2, jq. Read: lambda:ListTags, lambda:GetFunctionConfiguration,
# dynamodb:ListTagsOfResource, iam:ListRoleTags, logs:ListTagsForResource,
# s3:ListAllMyBuckets, s3:GetBucketLocation, s3:GetBucketTagging,
# events:ListTagsForResource, apigateway:GET. Write (--apply): lambda:TagResource,
# dynamodb:TagResource, iam:TagRole, logs:TagResource, s3:PutBucketTagging,
# events:TagResource, apigateway:POST on /tags.
set -euo pipefail

INFRA_ACCOUNT="966362334030"
REGION="us-east-1"

# shellcheck source=scripts/lib/service-tags.sh
. "$(dirname "$0")/lib/service-tags.sh"

PROFILE=""
APPLY=0
usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --apply) APPLY=1; shift ;;
    -h | --help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
if [ -z "$PROFILE" ]; then
  echo "ERROR: --profile is required (the infra account's profile, e.g. spore-host-infra)" >&2
  exit 2
fi
command -v jq >/dev/null || { echo "ERROR: jq is required" >&2; exit 2; }

awsp() { aws --profile "$PROFILE" "$@"; }

ACCOUNT=$(awsp sts get-caller-identity --query Account --output text)
if [ "$ACCOUNT" != "$INFRA_ACCOUNT" ]; then
  echo "ERROR: profile $PROFILE is account $ACCOUNT, not spore.host's infra account $INFRA_ACCOUNT. Refusing." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# The inventory: TYPE NAME COMPONENT DEPLOYED-BY
#
# From spore-host/spawn docs/infra-account.md and this repo, each checked
# against the code that reads or deploys it. Types:
#   lambda    function name           logs     log group name
#   dynamodb  table name              role     IAM role name
#   role-of   the role a FUNCTION runs under, read off the function (CFN-generated
#             and hand-made role names are not guessed)
#   bucket    bucket name             bucket-prefix  every bucket with this prefix
#   rule      EventBridge rule name (default bus)
#   http-api / ws-api   API Gateway v2 API, by name
#   domain    API Gateway v2 custom domain name
# ---------------------------------------------------------------------------
read -r -d '' INVENTORY <<'EOF' || true
# spore-rest-api: built by hand from infra/DEPLOY.md, which now carries --tags.
lambda    spore-rest-api                       rest-api                      infra/DEPLOY.md
logs      /aws/lambda/spore-rest-api           rest-api                      scripts/retag-service-resources.sh
role-of   spore-rest-api                       rest-api                      infra/DEPLOY.md
dynamodb  spore-api-keys                       rest-api                      infra/DEPLOY.md
dynamodb  spore-sms-pending                    rest-api                      infra/DEPLOY.md

# spore-bot: function and role are OpenTofu (infra/tofu/spore-bot, default_tags);
# its tables were created by hand and are in no stack or root.
lambda    spore-bot                            spore-bot                     infra/tofu/spore-bot
logs      /aws/lambda/spore-bot                spore-bot                     scripts/retag-service-resources.sh
role      spore-bot-role                       spore-bot                     infra/tofu/spore-bot
dynamodb  spore-bot-audit                      spore-bot                     scripts/retag-service-resources.sh
dynamodb  spore-bot-registry                   spore-bot                     scripts/retag-service-resources.sh
dynamodb  spore-bot-workspaces                 spore-bot                     scripts/retag-service-resources.sh

# spawn-dns-updater: OpenTofu owns the function and role here
# (infra/tofu/dns-updater); spawn's scripts/deploy-custom-dns.sh ships the code.
lambda    spawn-dns-updater                    dns-updater                   infra/tofu/dns-updater
logs      /aws/lambda/spawn-dns-updater        dns-updater                   scripts/deploy-custom-dns.sh
role-of   spawn-dns-updater                    dns-updater                   infra/tofu/dns-updater

# The dashboard (spawn lambda/dashboard-api, lambda/dashboard-websocket*).
lambda    spawn-dashboard-api                  dashboard-api                 lambda/dashboard-api/deploy.sh
logs      /aws/lambda/spawn-dashboard-api      dashboard-api                 lambda/dashboard-api/deploy.sh
role      SpawnDashboardLambdaRole             dashboard-api                 lambda/dashboard-api/scripts/setup-dashboard-lambda-role.sh
dynamodb  spawn-user-accounts                  dashboard-api                 lambda/dashboard-api/scripts/setup-user-accounts-table.sh
dynamodb  spawn-ws-tickets                     dashboard-api                 scripts/retag-service-resources.sh
dynamodb  spawn-teams                          dashboard-api                 scripts/setup-teams-tables.sh
dynamodb  spawn-team-memberships               dashboard-api                 scripts/setup-teams-tables.sh
http-api  spawn-dashboard-api                  dashboard-api                 lambda/dashboard-api/scripts/setup-dashboard-api-gateway.sh
domain    api.spore.host                       dashboard-api                 lambda/dashboard-api/scripts/setup-dashboard-domain.sh
lambda    spawn-dashboard-websocket            dashboard-websocket           lambda/dashboard-websocket/deploy.sh
logs      /aws/lambda/spawn-dashboard-websocket dashboard-websocket          lambda/dashboard-websocket/deploy.sh
dynamodb  spawn-websocket-connections          dashboard-websocket           lambda/dashboard-websocket/scripts/setup-websocket-table.sh
ws-api    spawn-dashboard-websocket            dashboard-websocket           lambda/dashboard-websocket/scripts/setup-websocket-api.sh
lambda    spawn-dashboard-websocket-processor  dashboard-websocket-processor lambda/dashboard-websocket-processor/deploy.sh
logs      /aws/lambda/spawn-dashboard-websocket-processor dashboard-websocket-processor lambda/dashboard-websocket-processor/deploy.sh

# Sweeps (spawn lambda/sweep-orchestrator).
lambda    spawn-sweep-orchestrator             sweep-orchestrator            scripts/deploy-sweep-orchestrator.sh
logs      /aws/lambda/spawn-sweep-orchestrator sweep-orchestrator            scripts/deploy-sweep-orchestrator.sh
role      SpawnSweepOrchestratorRole           sweep-orchestrator            scripts/setup-sweep-orchestrator-lambda-role.sh
dynamodb  spawn-sweep-orchestration            sweep-orchestrator            scripts/setup-sweep-dynamodb.sh
dynamodb  spawn-availability-stats             sweep-orchestrator            scripts/setup-availability-dynamodb.sh
bucket    spawn-sweeps-us-east-1               sweep-orchestrator            scripts/setup-sweep-s3-bucket.sh

# Pipelines (spawn lambda/pipeline-orchestrator, SAM: the template carries the
# same tags, so its next `make deploy` changes nothing).
lambda    spawn-pipeline-orchestrator          pipeline-orchestrator         lambda/pipeline-orchestrator/template.yaml
logs      /aws/lambda/spawn-pipeline-orchestrator pipeline-orchestrator      lambda/pipeline-orchestrator/template.yaml
role-of   spawn-pipeline-orchestrator          pipeline-orchestrator         lambda/pipeline-orchestrator/template.yaml
dynamodb  spawn-pipeline-orchestration         pipeline-orchestrator         lambda/pipeline-orchestrator/template.yaml
bucket    spawn-pipelines-us-east-1            pipeline-orchestrator         scripts/retag-service-resources.sh

# Schedules (spawn lambda/scheduler-handler). The tables are the spawn-schedules
# stack, whose template now carries the same tags; the buckets are created by
# `spawn schedule create` (pkg/staging), one per region, possibly with the
# account in the name.
lambda    scheduler-handler                    scheduler-handler             scripts/deploy-scheduler-handler.sh
logs      /aws/lambda/scheduler-handler        scheduler-handler             scripts/deploy-scheduler-handler.sh
role      SpawnSchedulerHandlerExecutionRole   scheduler-handler             deployment/cloudformation/scheduler-handler-role.yaml
dynamodb  spawn-schedules                      scheduler-handler             scripts/setup-schedules-dynamodb.sh
dynamodb  spawn-schedule-history               scheduler-handler             scripts/setup-schedules-dynamodb.sh
bucket-prefix spawn-schedules-                 scheduler-handler             pkg/staging/staging.go

# Cost history (spawn lambda/cost-history-collector). The hourly rule was made
# by hand; the deploy script deliberately does not own it.
lambda    spawn-cost-history-collector         cost-history-collector        scripts/deploy-cost-history-collector.sh
logs      /aws/lambda/spawn-cost-history-collector cost-history-collector    scripts/deploy-cost-history-collector.sh
dynamodb  spawn-cost-history                   cost-history-collector        scripts/retag-service-resources.sh
rule      spawn-cost-history-collector-hourly  cost-history-collector        scripts/retag-service-resources.sh

# The TTL reaper (spawn lambda/ttl-reaper, SAM: template tags + PropagateTags).
lambda    spawn-ttl-reaper-production          ttl-reaper                    lambda/ttl-reaper/template.yaml
logs      /aws/lambda/spawn-ttl-reaper-production ttl-reaper                 lambda/ttl-reaper/template.yaml
role-of   spawn-ttl-reaper-production          ttl-reaper                    lambda/ttl-reaper/template.yaml

# spawn's CI deploy role (spawn scripts/setup-lambda-deploy-ci-role.sh).
role      GitHubActions-spawn-lambda-deploy    lambda-deploy-ci              scripts/setup-lambda-deploy-ci-role.sh

# lagotto's tables in the infra account, read by the dashboard (spawn
# lambda/dashboard-api/watches.go). "lagotto" is not one of #750's component
# ids, which name spore.host's own service; confirm or change it here.
dynamodb  lagotto-watches                      lagotto                       scripts/retag-service-resources.sh
dynamodb  lagotto-match-history                lagotto                       scripts/retag-service-resources.sh
EOF

# Live service resources deliberately NOT tagged here: #750 assigns them no
# component id. Listed so the gap is visible rather than forgotten.
read -r -d '' UNASSIGNED <<'EOF' || true
spawn-binaries-<region> x11 buckets       the spored distribution the release workflow writes; load-bearing for every launch
spawn-cloudformation-artifacts-us-east-1  SAM packaging bucket, shared by the SAM stacks
spawn-certs-us-east-1                     bucket with no reference in spawn
spore-host-docs, spore-host-website       the docs and web sites (infra/tofu/docs-site, infra/tofu/site)
spore-portal-accounts                     the portal account registry (portal-phone-home)
portal-phone-home, lagotto-capacity-poller, spawn-ts-portal   functions deployed from other roots and repos
EOF

# ---------------------------------------------------------------------------
# Reading and writing one resource's tags. Every reader prints a JSON object
# {key: value}; a resource that does not exist prints the word ABSENT.
# ---------------------------------------------------------------------------
lambda_arn() { echo "arn:aws:lambda:${REGION}:${ACCOUNT}:function:$1"; }
table_arn() { echo "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/$1"; }
logs_arn() { echo "arn:aws:logs:${REGION}:${ACCOUNT}:log-group:$1"; }
rule_arn() { echo "arn:aws:events:${REGION}:${ACCOUNT}:rule/$1"; }
apigw_arn() { echo "arn:aws:apigateway:${REGION}::$1"; }

# absent_or_fail ERRFILE: ABSENT for a not-found error, otherwise the error and
# failure, so an AccessDenied is never mistaken for a missing resource.
absent_or_fail() {
  if grep -qE 'ResourceNotFound|NoSuchEntity|NotFoundException|NoSuchBucket|does not exist' "$1"; then
    echo ABSENT
    return 0
  fi
  cat "$1" >&2
  return 1
}

ERRF=$(mktemp)
trap 'rm -f "$ERRF"' EXIT

read_tags() { # TYPE ID
  local t=$1 id=$2 out
  case "$t" in
    lambda)
      out=$(awsp lambda list-tags --resource "$(lambda_arn "$id")" --region "$REGION" --query Tags --output json 2>"$ERRF") || { absent_or_fail "$ERRF"; return; }
      jq -c '. // {}' <<<"$out" ;;
    logs)
      out=$(awsp logs list-tags-for-resource --resource-arn "$(logs_arn "$id")" --region "$REGION" --query tags --output json 2>"$ERRF") || { absent_or_fail "$ERRF"; return; }
      jq -c '. // {}' <<<"$out" ;;
    dynamodb)
      out=$(awsp dynamodb list-tags-of-resource --resource-arn "$(table_arn "$id")" --region "$REGION" --query Tags --output json 2>"$ERRF") || { absent_or_fail "$ERRF"; return; }
      jq -c '(. // []) | from_entries' <<<"$out" ;;
    role)
      out=$(awsp iam list-role-tags --role-name "$id" --query Tags --output json 2>"$ERRF") || { absent_or_fail "$ERRF"; return; }
      jq -c '(. // []) | from_entries' <<<"$out" ;;
    bucket)
      out=$(awsp s3api get-bucket-tagging --bucket "$id" --query TagSet --output json 2>"$ERRF") || {
        if grep -q NoSuchTagSet "$ERRF"; then echo '{}'; return; fi
        absent_or_fail "$ERRF"; return
      }
      jq -c '(. // []) | from_entries' <<<"$out" ;;
    rule)
      out=$(awsp events list-tags-for-resource --resource-arn "$(rule_arn "$id")" --region "$REGION" --query Tags --output json 2>"$ERRF") || { absent_or_fail "$ERRF"; return; }
      jq -c '(. // []) | from_entries' <<<"$out" ;;
    apigw)
      out=$(awsp apigatewayv2 get-tags --resource-arn "$(apigw_arn "$id")" --region "$REGION" --query Tags --output json 2>"$ERRF") || { absent_or_fail "$ERRF"; return; }
      jq -c '. // {}' <<<"$out" ;;
  esac
}

write_tags() { # TYPE ID COMPONENT DEPLOYED_BY
  local t=$1 id=$2 c=$3 d=$4 list map current merged
  local -a tags
  read -r -a tags <<<"$(spore_service_tags_list "$c" "$d")"
  map=$(spore_service_tags_map "$c" "$d")
  case "$t" in
    lambda) awsp lambda tag-resource --resource "$(lambda_arn "$id")" --tags "$map" --region "$REGION" ;;
    logs) awsp logs tag-resource --resource-arn "$(logs_arn "$id")" --tags "$map" --region "$REGION" ;;
    dynamodb) awsp dynamodb tag-resource --resource-arn "$(table_arn "$id")" --tags "${tags[@]}" --region "$REGION" ;;
    role) awsp iam tag-role --role-name "$id" --tags "${tags[@]}" ;;
    rule) awsp events tag-resource --resource-arn "$(rule_arn "$id")" --tags "${tags[@]}" --region "$REGION" ;;
    apigw) awsp apigatewayv2 tag-resource --resource-arn "$(apigw_arn "$id")" --tags "$map" --region "$REGION" >/dev/null ;;
    bucket)
      # put-bucket-tagging replaces the whole set: read it, add ours, write it
      # back. read_tags already refused a bucket whose tags it could not read.
      current=$(read_tags bucket "$id")
      merged=$(jq -c \
        --arg rk "$SPORE_HOST_ROLE_KEY" --arg rv "$SPORE_HOST_ROLE_SERVICE" \
        --arg ck "$SPORE_HOST_COMPONENT_KEY" --arg cv "$c" \
        --arg dk "$SPORE_HOST_DEPLOYED_BY_KEY" --arg dv "$d" \
        '. + {($rk): $rv, ($ck): $cv, ($dk): $dv} | {TagSet: to_entries | map({Key: .key, Value: .value})}' \
        <<<"$current")
      list=$(jq -r '.TagSet | length' <<<"$merged")
      if [ "$list" -gt 50 ]; then
        echo "ERROR: $id would carry $list tags, over S3's limit of 50" >&2
        return 1
      fi
      awsp s3api put-bucket-tagging --bucket "$id" --tagging "$merged" ;;
  esac
}

# show TAGS_JSON: the three keys, role/component/deployed-by, "-" for unset.
show() {
  jq -r --arg rk "$SPORE_HOST_ROLE_KEY" --arg ck "$SPORE_HOST_COMPONENT_KEY" --arg dk "$SPORE_HOST_DEPLOYED_BY_KEY" \
    '[.[$rk] // "-", .[$ck] // "-", .[$dk] // "-"] | join(" / ")' <<<"$1"
}

# ---------------------------------------------------------------------------
# Expand the inventory into concrete rows: TYPE ID LABEL COMPONENT DEPLOYED_BY.
# role-of, bucket-prefix and the APIs are resolved here, read-only.
# ---------------------------------------------------------------------------
ROWS=()
add_row() { ROWS+=("$1|$2|$3|$4|$5"); }

while read -r type name component deployed_by; do
  case "$type" in "" | \#*) continue ;; esac
  case "$type" in
    lambda | logs | dynamodb | role | bucket | rule)
      add_row "$type" "$name" "$name" "$component" "$deployed_by" ;;
    role-of)
      if role_arn=$(awsp lambda get-function-configuration --function-name "$name" --region "$REGION" --query Role --output text 2>"$ERRF"); then
        add_row role "${role_arn##*/}" "${role_arn##*/} (role of $name)" "$component" "$deployed_by"
      elif [ "$(absent_or_fail "$ERRF")" = ABSENT ]; then
        add_row missing "$name" "role of $name (no such function)" "$component" "$deployed_by"
      else
        add_row unreadable "$name" "role of $name" "$component" "$deployed_by"
      fi ;;
    bucket-prefix)
      found=0
      for b in $(awsp s3api list-buckets --prefix "$name" --query 'Buckets[].Name' --output text); do
        [ "$b" = "None" ] && continue
        case "$b" in "$name"*) add_row bucket "$b" "$b" "$component" "$deployed_by"; found=1 ;; esac
      done
      [ "$found" = 1 ] || add_row missing "$name*" "$name* (no bucket)" "$component" "$deployed_by" ;;
    http-api | ws-api)
      proto=HTTP; [ "$type" = ws-api ] && proto=WEBSOCKET
      ids=$(awsp apigatewayv2 get-apis --region "$REGION" \
        --query "Items[?Name=='$name' && ProtocolType=='$proto'].ApiId" --output text)
      if [ -z "$ids" ] || [ "$ids" = "None" ]; then
        add_row missing "$name" "$name ($proto API)" "$component" "$deployed_by"
      fi
      for id in $ids; do
        [ "$id" = "None" ] && continue
        add_row apigw "/apis/$id" "$name ($proto API $id)" "$component" "$deployed_by"
      done ;;
    domain)
      add_row apigw "/domainnames/$name" "$name (API domain)" "$component" "$deployed_by" ;;
    *)
      echo "ERROR: unknown inventory type $type" >&2
      exit 1 ;;
  esac
done <<<"$INVENTORY"

if [ "${#ROWS[@]}" -eq 0 ]; then
  echo "ERROR: the inventory expanded to nothing; the script is broken, not the account" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Before, apply, after.
# ---------------------------------------------------------------------------
mode="DRY RUN (nothing written; pass --apply to write)"
[ "$APPLY" = 1 ] && mode="APPLY"
echo "Account $ACCOUNT, region $REGION, profile $PROFILE: $mode"
echo "Columns show spore-host:role / spore-host:component / spore-host:deployed-by."
echo

failed=0
tagged=0
current_n=0
absent=0
fmt='%-9s %-58s %-50s %-50s %s\n'
# shellcheck disable=SC2059 # the format is this constant
printf "$fmt" TYPE RESOURCE BEFORE AFTER RESULT
for row in "${ROWS[@]}"; do
  IFS='|' read -r type id label component deployed_by <<<"$row"
  want=$(jq -cn --arg rk "$SPORE_HOST_ROLE_KEY" --arg rv "$SPORE_HOST_ROLE_SERVICE" \
    --arg ck "$SPORE_HOST_COMPONENT_KEY" --arg cv "$component" \
    --arg dk "$SPORE_HOST_DEPLOYED_BY_KEY" --arg dv "$deployed_by" \
    '{($rk): $rv, ($ck): $cv, ($dk): $dv}')
  if [ "$type" = unreadable ]; then
    # shellcheck disable=SC2059
    printf "$fmt" "-" "$label" "?" "?" "FAILED to read the function's role; not written"
    failed=$((failed + 1))
    continue
  fi
  if [ "$type" = missing ]; then
    # shellcheck disable=SC2059
    printf "$fmt" "-" "$label" "-" "-" "absent, skipped"
    absent=$((absent + 1))
    continue
  fi
  if ! before=$(read_tags "$type" "$id"); then
    # shellcheck disable=SC2059
    printf "$fmt" "$type" "$label" "?" "?" "FAILED to read tags; not written"
    failed=$((failed + 1))
    continue
  fi
  if [ "$before" = ABSENT ]; then
    # shellcheck disable=SC2059
    printf "$fmt" "$type" "$label" "-" "-" "absent, skipped"
    absent=$((absent + 1))
    continue
  fi
  if [ "$(jq -c --argjson w "$want" '. as $b | [$w | to_entries[] | $b[.key] == .value] | all' <<<"$before")" = true ]; then
    # shellcheck disable=SC2059
    printf "$fmt" "$type" "$label" "$(show "$before")" "$(show "$before")" "already tagged"
    current_n=$((current_n + 1))
    continue
  fi
  if [ "$APPLY" != 1 ]; then
    # shellcheck disable=SC2059
    printf "$fmt" "$type" "$label" "$(show "$before")" "$(show "$want")" "would tag"
    tagged=$((tagged + 1))
    continue
  fi
  if ! write_tags "$type" "$id" "$component" "$deployed_by" 2>"$ERRF"; then
    # shellcheck disable=SC2059
    printf "$fmt" "$type" "$label" "$(show "$before")" "$(show "$before")" "FAILED: $(tr '\n' ' ' <"$ERRF")"
    failed=$((failed + 1))
    continue
  fi
  after=$(read_tags "$type" "$id" || echo '{}')
  result="tagged"
  if [ "$(jq -c --argjson w "$want" '. as $a | [$w | to_entries[] | $a[.key] == .value] | all' <<<"$after")" != true ]; then
    result="FAILED: tags do not read back"
    failed=$((failed + 1))
  elif [ "$(jq -c --argjson b "$before" '. as $a | [$b | to_entries[] | $a[.key] != null] | all' <<<"$after")" != true ]; then
    result="FAILED: an existing tag is gone"
    failed=$((failed + 1))
  else
    tagged=$((tagged + 1))
  fi
  # shellcheck disable=SC2059
  printf "$fmt" "$type" "$label" "$(show "$before")" "$(show "$after")" "$result"
done

echo
verb="would be tagged"
[ "$APPLY" = 1 ] && verb="tagged"
echo "${#ROWS[@]} resources: $tagged $verb, $current_n already tagged, $absent absent, $failed failed."
echo
echo "Not tagged here (no component id assigned in #750):"
while IFS= read -r line; do echo "  $line"; done <<<"$UNASSIGNED"
[ "$failed" -eq 0 ]
