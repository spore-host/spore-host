#!/usr/bin/env bash
# shellcheck disable=SC2016 # fixtures are Makefile text: $(VAR) and $$x are meant literally
# Tests for scripts/check-deploy-paths.sh, run against throwaway directories.
# No network, no credentials: `make -n` runs no recipe lines.
#
# Usage:  scripts/test-check-deploy-paths.sh
set -uo pipefail

CHECK="$(cd "$(dirname "$0")" && pwd)/check-deploy-paths.sh"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

failures=0
n=0

# fixture <name> <makefile-body>: $ROOT/<name>/lambda/fn/Makefile with that body.
fixture() {
  mkdir -p "$ROOT/$1/lambda/fn"
  printf '%b' "$2" > "$ROOT/$1/lambda/fn/Makefile"
  echo "$ROOT/$1"
}

# expect <ok|fail> <description> <dir> [text the output must contain]
expect() {
  local want="$1" desc="$2" dir="$3" pat="${4:-}" out rc got
  n=$((n + 1))
  out="$("$CHECK" "$dir" 2>&1)"; rc=$?
  got=ok; [ "$rc" -ne 0 ] && got=fail
  if [ "$got" != "$want" ]; then
    printf 'FAIL  %s: check returned %s, want %s\n%s\n' "$desc" "$got" "$want" "$(printf '%s\n' "$out" | sed 's/^/      /')"
    failures=$((failures + 1))
  elif [ -n "$pat" ] && ! printf '%s' "$out" | grep -qF -- "$pat"; then
    printf 'FAIL  %s: output lacks %q\n%s\n' "$desc" "$pat" "$(printf '%s\n' "$out" | sed 's/^/      /')"
    failures=$((failures + 1))
  else
    printf 'ok    %s\n' "$desc"
  fi
}

# Empty discovery must fail, not pass vacuously.
d="$ROOT/empty"; mkdir -p "$d"
expect fail "no Makefile at all" "$d" "no Makefile with a deploy: target"
d="$(fixture nodeploy 'build:\n\techo hi\n')"
expect fail "Makefile without a deploy target" "$d" "no Makefile with a deploy: target"

# The #570 shape: a CloudFormation template that is not in the checkout.
d="$(fixture missing-template 'T := ../../deployment/cloudformation/gone.yaml\ndeploy:\n\taws cloudformation deploy --template-file $(T) --stack-name x\n')"
expect fail "missing --template-file (via a variable)" "$d" "gone.yaml"

d="$(fixture present-template 'deploy:\n\taws cloudformation deploy --template-file template.yaml --stack-name x\n')"
touch "$d/lambda/fn/template.yaml"
expect ok "existing --template-file" "$d"

d="$(fixture eq-form 'deploy:\n\taws cloudformation deploy --template-file=nope.yaml\n')"
expect fail "missing --template-file=PATH" "$d" "nope.yaml"

d="$(fixture fileb 'deploy:\n\taws lambda update-function-code --function-name f --zip-file fileb://out/f.zip\n')"
expect fail "missing fileb:// reference" "$d" "out/f.zip"

d="$(fixture script 'deploy:\n\t./scripts/deploy.sh\n')"
expect fail "missing script" "$d" "scripts/deploy.sh"

d="$(fixture shellvar 'deploy:\n\tf=x; aws cloudformation deploy --template-file $$f.yaml\n')"
expect fail "reference built from a shell variable" "$d" "cannot be checked"

# A missing file reached only through a prerequisite and a recursive make.
d="$(fixture recursive 'deploy: pre\n\t$(MAKE) stack\npre:\n\techo pre\nstack:\n\taws cloudformation deploy --template-file deep.yml\n')"
expect fail "missing file behind \$(MAKE)" "$d" "deep.yml"

d="$(fixture remote 'deploy:\n\taws s3 cp f.zip s3://bucket/key.json\n\tcurl -fsS https://example.invalid/x.sh\n')"
expect ok "s3:// and https:// are not local files" "$d"

d="$(fixture brokenprereq 'deploy: nosuchtarget\n\techo hi\n')"
expect fail "make -n deploy itself fails" "$d" "make -n deploy failed"

d="$(fixture norecipe 'deploy:\n')"
expect fail "deploy with no commands" "$d" "printed no commands"

# And the real repository passes.
expect ok "this repository" "$REPO" "lambda/spore-bot/Makefile"

echo "$((n - failures))/$n passed"
[ "$failures" -eq 0 ]
