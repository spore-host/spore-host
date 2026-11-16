# shellcheck shell=bash
#
# The spore-host:* service tags (#750). Sourced, never run.
#
# The infra account's service resources mostly carry spawn:managed=true, which is
# also the tag spawn puts on workload litter, and a litter classifier marked 12
# live resources as litter. So every service resource also carries:
#
#   spore-host:role=service
#   spore-host:component=<id>
#   spore-host:deployed-by=<repo-relative path of the deploy mechanism>
#
# This file is the one place this repo's shell scripts take the keys from. The
# OpenTofu roots write the same keys in their provider default_tags. spawn has
# its own copy (scripts/lib/service-tags.sh there), with the same keys.

SPORE_HOST_ROLE_KEY="spore-host:role"
SPORE_HOST_ROLE_SERVICE="service"
SPORE_HOST_COMPONENT_KEY="spore-host:component"
SPORE_HOST_DEPLOYED_BY_KEY="spore-host:deployed-by"
# The three keys, for a caller that reads them back.
# shellcheck disable=SC2034 # read by the sourcing script
SPORE_HOST_SERVICE_KEYS=("$SPORE_HOST_ROLE_KEY" "$SPORE_HOST_COMPONENT_KEY" "$SPORE_HOST_DEPLOYED_BY_KEY")

# _spore_check COMPONENT DEPLOYED_BY: both are needed, and neither may hold a
# character the CLI shorthand would split on.
_spore_check() {
  case "$1$2" in
    *" "* | *,* | *=*) echo "ERROR: service tag value '$1' / '$2' holds a space, comma or '='" >&2; return 1 ;;
  esac
  if [ -z "$1" ] || [ -z "$2" ]; then
    echo "ERROR: a service tag needs both a component and a deployed-by path" >&2
    return 1
  fi
}

# spore_service_tags_list COMPONENT DEPLOYED_BY
# The IAM / DynamoDB / EventBridge / CloudFormation shorthand, one word per tag:
#   read -r -a TAGS <<<"$(spore_service_tags_list c path)"; aws iam tag-role ... --tags "${TAGS[@]}"
spore_service_tags_list() {
  _spore_check "$1" "$2" || return 1
  printf 'Key=%s,Value=%s Key=%s,Value=%s Key=%s,Value=%s\n' \
    "$SPORE_HOST_ROLE_KEY" "$SPORE_HOST_ROLE_SERVICE" \
    "$SPORE_HOST_COMPONENT_KEY" "$1" \
    "$SPORE_HOST_DEPLOYED_BY_KEY" "$2"
}

# spore_service_tags_map COMPONENT DEPLOYED_BY
# The Lambda / CloudWatch Logs / API Gateway v2 shorthand, k=v,k=v,k=v.
spore_service_tags_map() {
  _spore_check "$1" "$2" || return 1
  printf '%s=%s,%s=%s,%s=%s\n' \
    "$SPORE_HOST_ROLE_KEY" "$SPORE_HOST_ROLE_SERVICE" \
    "$SPORE_HOST_COMPONENT_KEY" "$1" \
    "$SPORE_HOST_DEPLOYED_BY_KEY" "$2"
}
