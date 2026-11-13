#!/usr/bin/env bash
# Tests for provision-wildcard-cert.sh (spore-host#695), against a stub `aws`
# on PATH. No network, no credentials, no certbot: every case runs with
# --policy-only or --dry-run, or is refused before any write.
#
# Usage:  infra/certs/test-provision-wildcard-cert.sh
# shellcheck disable=SC2015 # pass and fail always return 0, so A && pass || fail is safe
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/provision-wildcard-cert.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$ROOT/bin"
# The stub reads its behaviour from files in $STUB and logs every call.
#   caller    account id get-caller-identity returns
#   mgmt      org management account id (absent: describe-organization fails)
#   policy    current bucket policy (absent: NoSuchBucketPolicy)
#   getfail   if present, get-bucket-policy fails with AccessDenied
#   put       written by put-bucket-policy
cat > "$ROOT/bin/aws" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB/calls"
case "$1 $2" in
  "sts get-caller-identity") cat "$STUB/caller" ;;
  "organizations describe-organization")
    [ -f "$STUB/mgmt" ] || { echo "AWSOrganizationsNotInUseException" >&2; exit 254; }
    cat "$STUB/mgmt" ;;
  "s3api head-bucket") exit 0 ;;
  "s3api put-public-access-block") exit 0 ;;
  "s3api get-bucket-policy")
    [ -f "$STUB/getfail" ] && { echo "An error occurred (AccessDenied) when calling the GetBucketPolicy operation" >&2; exit 254; }
    [ -f "$STUB/policy" ] || { echo "An error occurred (NoSuchBucketPolicy) when calling the GetBucketPolicy operation" >&2; exit 254; }
    cat "$STUB/policy" ;;
  "s3api put-bucket-policy")
    while [ $# -gt 0 ]; do [ "$1" = "--policy" ] && { printf '%s' "$2" > "$STUB/put"; }; shift; done ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$ROOT/bin/aws"

failures=0
n=0
case_dir() { STUB="$ROOT/case$n"; rm -rf "$STUB"; mkdir -p "$STUB"; echo 966362334030 > "$STUB/caller"; export STUB; }

# run <args...>: sets OUT and RC.
run() { OUT="$(PATH="$ROOT/bin:$PATH" "$SCRIPT" "$@" 2>&1)"; RC=$?; }

pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s: %s\n%s\n' "$1" "$2" "$(printf '%s\n' "$OUT" | sed 's/^/      /')"; failures=$((failures + 1)); }

# expect_rc <0|nonzero> <desc>
expect_rc() {
  if { [ "$1" = 0 ] && [ "$RC" -eq 0 ]; } || { [ "$1" != 0 ] && [ "$RC" -ne 0 ]; }; then return 0; fi
  fail "$2" "exit $RC, want $1"; return 1
}

LIVE='{"Version":"2012-10-17","Statement":[
 {"Sid":"SporeInstanceRoleRead","Effect":"Allow","Principal":{"AWS":["arn:aws:iam::966362334030:role/spored-instance-role"]},"Action":"s3:GetObject","Resource":"arn:aws:s3:::spawn-certs-us-east-1/aaaa1111/*"},
 {"Sid":"SporeAppRoleRead","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::111111111111:role/some-app"},"Action":"s3:GetObject","Resource":"arn:aws:s3:::spawn-certs-us-east-1/aaaa1111/*"},
 {"Sid":"SporeAppRoleReadDev","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::435415984226:role/some-app"},"Action":["s3:GetObject"],"Resource":["arn:aws:s3:::spawn-certs-us-east-1/bbbb2222/*"],"Condition":{"Bool":{"aws:SecureTransport":"true"}}}
]}'

# 1. A new prefix adds one statement and keeps all three existing ones verbatim.
n=$((n+1)); case_dir; d="new prefix is added, every existing statement kept"
printf '%s' "$LIVE" > "$STUB/policy"
run --policy-only cccc3333 us-east-1 435415984226
if expect_rc 0 "$d"; then
  if [ "$(jq '.Statement | length' "$STUB/put")" != 4 ]; then fail "$d" "want 4 statements"
  elif ! jq -e --argjson live "$LIVE" '[$live.Statement[] as $s | any(.Statement[]; . == $s)] | all' "$STUB/put" >/dev/null; then fail "$d" "an existing statement changed"
  elif ! jq -e '.Statement[3] == {Sid:"SporeInstanceRoleReadcccc3333",Effect:"Allow",
        Principal:{AWS:["arn:aws:iam::435415984226:role/spored-instance-role","arn:aws:iam::966362334030:role/spored-instance-role"]},
        Action:"s3:GetObject",Resource:"arn:aws:s3:::spawn-certs-us-east-1/cccc3333/*"}' "$STUB/put" >/dev/null; then fail "$d" "new statement wrong"
  else pass "$d"; fi
fi

# 2. An existing prefix's statement gains principals; nothing is removed, Sid kept.
n=$((n+1)); case_dir; d="existing prefix: principals added, not replaced"
printf '%s' "$LIVE" > "$STUB/policy"
run --policy-only aaaa1111 us-east-1 435415984226
if expect_rc 0 "$d"; then
  if [ "$(jq '.Statement | length' "$STUB/put")" != 3 ]; then fail "$d" "want 3 statements"
  elif ! jq -e '.Statement[0].Sid == "SporeInstanceRoleRead" and (.Statement[0].Principal.AWS | sort) ==
        ["arn:aws:iam::435415984226:role/spored-instance-role","arn:aws:iam::966362334030:role/spored-instance-role"]' "$STUB/put" >/dev/null; then fail "$d" "principals wrong"
  elif ! jq -e --argjson live "$LIVE" '.Statement[1:] == $live.Statement[1:]' "$STUB/put" >/dev/null; then fail "$d" "other statements changed"
  else pass "$d"; fi
fi

# 3. A re-run without extras keeps earlier extra accounts.
n=$((n+1)); case_dir; d="re-run without extras keeps earlier grants"
printf '%s' "$LIVE" | jq -c '.Statement[0].Principal.AWS += ["arn:aws:iam::435415984226:role/spored-instance-role"]' > "$STUB/policy"
run --policy-only aaaa1111 us-east-1
if expect_rc 0 "$d"; then
  jq -e '.Statement[0].Principal.AWS | index("arn:aws:iam::435415984226:role/spored-instance-role")' "$STUB/put" >/dev/null \
    && pass "$d" || fail "$d" "earlier grant dropped"
fi

# 4. No policy yet: starts from empty.
n=$((n+1)); case_dir; d="no bucket policy yet"
run --policy-only cccc3333 us-east-1
if expect_rc 0 "$d"; then
  [ "$(jq '.Statement | length' "$STUB/put")" = 1 ] && pass "$d" || fail "$d" "want 1 statement"
fi

# 5. Any other read failure must not write.
n=$((n+1)); case_dir; d="unreadable policy: refused, nothing written"
touch "$STUB/getfail"
run --policy-only cccc3333 us-east-1
if expect_rc 1 "$d"; then [ -f "$STUB/put" ] && fail "$d" "policy written" || pass "$d"; fi

# 6. The forbidden account, as an extra account.
n=$((n+1)); case_dir; d="942542972736 refused as an extra account"
run --policy-only cccc3333 us-east-1 942542972736
if expect_rc 1 "$d"; then
  if [ -f "$STUB/put" ]; then fail "$d" "policy written"
  elif grep -q "s3api" "$STUB/calls"; then fail "$d" "touched S3 before refusing"
  else pass "$d"; fi
fi

# 7. The forbidden account, as the caller.
n=$((n+1)); case_dir; d="942542972736 refused as the caller"
echo 942542972736 > "$STUB/caller"
CERT_BUCKET_ACCOUNT=942542972736 run --policy-only cccc3333 us-east-1
if expect_rc 1 "$d"; then [ -f "$STUB/put" ] && fail "$d" "policy written" || pass "$d"; fi

# 8. Wrong account.
n=$((n+1)); case_dir; d="caller is not the cert-bucket account"
echo 435415984226 > "$STUB/caller"
run --policy-only cccc3333 us-east-1
if expect_rc 1 "$d"; then grep -q "expected the cert-bucket account" <<<"$OUT" && pass "$d" || fail "$d" "wrong message"; fi

# 9. The caller's org management account, as an extra account.
n=$((n+1)); case_dir; d="org management account refused as an extra account"
echo 222222222222 > "$STUB/mgmt"
run --policy-only cccc3333 us-east-1 222222222222
if expect_rc 1 "$d"; then [ -f "$STUB/put" ] && fail "$d" "policy written" || pass "$d"; fi

# 10. Malformed input never reaches a policy.
n=$((n+1)); case_dir; d="malformed account id refused"
run --policy-only cccc3333 us-east-1 '1234"}]}'
expect_rc 1 "$d" && pass "$d"
n=$((n+1)); case_dir; d="malformed base36 refused"
run --policy-only 'x/*' us-east-1
expect_rc 1 "$d" && pass "$d"

# 11. --dry-run writes nothing and prints the merge.
n=$((n+1)); case_dir; d="--dry-run writes nothing"
printf '%s' "$LIVE" > "$STUB/policy"
run --dry-run cccc3333 us-east-1
if expect_rc 0 "$d"; then
  if [ -f "$STUB/put" ] || grep -q "put-public-access-block\|create-bucket" "$STUB/calls"; then fail "$d" "wrote something"
  else grep -q "SporeInstanceRoleReadcccc3333" <<<"$OUT" && pass "$d" || fail "$d" "merged policy not printed"; fi
fi

# 12. An existing forbidden principal elsewhere is kept, with a warning.
n=$((n+1)); case_dir; d="pre-existing forbidden principal is kept and warned about"
printf '%s' "$LIVE" | jq -c '.Statement[1].Principal.AWS = "arn:aws:iam::942542972736:role/x"' > "$STUB/policy"
run --policy-only cccc3333 us-east-1
if expect_rc 0 "$d"; then
  if ! grep -q WARNING <<<"$OUT"; then fail "$d" "no warning"
  elif [ "$(jq '.Statement | length' "$STUB/put")" != 4 ]; then fail "$d" "statements changed"
  else pass "$d"; fi
fi

# 13. Two statements claiming the same prefix: refuse rather than guess.
n=$((n+1)); case_dir; d="ambiguous ownership refused"
printf '%s' "$LIVE" | jq -c '.Statement += [.Statement[0] | .Sid = "SporeInstanceRoleRead2"]' > "$STUB/policy"
run --policy-only aaaa1111 us-east-1
if expect_rc 1 "$d"; then [ -f "$STUB/put" ] && fail "$d" "policy written" || pass "$d"; fi

echo
if [ "$failures" -ne 0 ]; then echo "$failures of $n case(s) failed"; exit 1; fi
echo "all $n cases passed"
