#!/usr/bin/env bash
# Assert every GitHub Actions workflow pins the same Go version.
#
# The Go version is written out separately in each workflow's setup-go step.
# When one was bumped and another wasn't (#556), CI built and tested with one
# toolchain and vuln-scanned with another, and the scan went red on stdlib
# findings that the tested toolchain had already fixed. This gate makes that
# drift a CI failure instead of a surprise (#559).
#
# It discovers every `go-version:` key in .github/workflows/*.{yml,yaml} and
# fails if:
#   - none are found (the discovery itself broke, e.g. files moved or the key
#     was renamed — a gate that checks nothing must not pass),
#   - any pin is not a literal version (e.g. `${{ matrix.go }}`), which this
#     gate cannot verify, or
#   - the literal pins are not all identical.
#
# Usage: scripts/check-go-version-pins.sh [workflows-dir]
set -euo pipefail

dir="${1:-$(git rev-parse --show-toplevel)/.github/workflows}"

cd "$dir" || { echo "::error::workflows dir $dir not found"; exit 1; }
shopt -s nullglob
files=(*.yml *.yaml)
if [ "${#files[@]}" -eq 0 ]; then
  echo "::error::no workflow files found in $dir"
  exit 1
fi

# file:line:value, value stripped of quotes, trailing comments and whitespace.
pins="$(grep -HnE '^[[:space:]]*go-version:' "${files[@]}" |
  sed -E 's/^([^:]+:[0-9]+):[[:space:]]*go-version:[[:space:]]*/\1:/;
          s/[[:space:]]+#.*$//; s/["'\'']//g; s/[[:space:]]+$//' || true)"

if [ -z "$pins" ]; then
  echo "::error::no go-version pins found in ${#files[@]} workflow file(s) under $dir"
  exit 1
fi

fail=0
while IFS= read -r p; do
  loc="$(printf '%s' "$p" | cut -d: -f1-2)"
  v="${p#"$loc":}"
  if ! [[ "$v" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
    echo "::error::$loc: go-version '$v' is not a literal X.Y[.Z] version"
    fail=1
  fi
done <<< "$pins"

versions="$(printf '%s\n' "$pins" | sed -E 's/^[^:]+:[0-9]+://' | sort -u)"
count="$(printf '%s\n' "$pins" | wc -l | tr -d ' ')"

if [ "$(printf '%s\n' "$versions" | wc -l | tr -d ' ')" -ne 1 ]; then
  echo "::error::workflows pin different Go versions:"
  printf '%s\n' "$pins" | sed 's/^/  /'
  fail=1
fi

[ "$fail" -eq 0 ] || exit 1
echo "ok: all $count go-version pin(s) across ${#files[@]} workflow file(s) are $versions"
