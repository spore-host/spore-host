#!/bin/bash
# Every generated CLI reference page (docs/gen/<cli>/*.md, vendored by
# sync-cli-docs) must be @included by docs/tools/reference/<cli>.md, unless the
# command is deprecated (its page carries a "> **Deprecated:**" line), which
# the reference deliberately leaves out. The include list is hand-maintained,
# so without this gate a new command's page is vendored but never rendered:
# spawn egress-proxy (v0.157.0) and lagotto ack/update/notify-gc were.
set -euo pipefail
cd "$(dirname "$0")/../docs"
fail=0
for dir in gen/*/; do
  cli=$(basename "$dir")
  ref="tools/reference/$cli.md"
  [ -f "$ref" ] || { echo "::error::$ref is missing for docs/gen/$cli"; fail=1; continue; }
  for page in "$dir"*.md; do
    name=$(basename "$page")
    grep -q '^> \*\*Deprecated:\*\*' "$page" && continue
    if ! grep -qF "gen/$cli/$name" "$ref"; then
      echo "::error file=docs/$ref::docs/gen/$cli/$name is not included; add: <!-- @include: ../../gen/$cli/$name -->"
      fail=1
    fi
  done
done
exit $fail
