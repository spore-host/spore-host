#!/usr/bin/env bash
# Assert that no Makefile's `deploy` target references a file that does not exist.
#
# Why (#570): lambda/spore-bot's `make deploy` ran
#   aws cloudformation deploy --template-file ../../deployment/cloudformation/spore-bot.yaml
# after uploading the zip. That template did not exist, so every deploy uploaded
# the code to S3 and then failed — the function was never updated, and nothing
# in CI could notice because nothing read the target.
#
# How: for every Makefile (outside node_modules) that defines a `deploy:` target,
# take the target's commands as make would run them — `make -n deploy`, so
# variables are expanded and recursive $(MAKE) calls are followed — and extract
# every file reference:
#   - the argument of --template-file / --cli-input-json / --cli-input-yaml
#   - anything after file:// or fileb://
#   - any other token ending in .yaml .yml .json .sh .py .tf .tpl
# Each must exist, resolved relative to the Makefile's directory (or absolute).
# A reference built from a shell variable ($x) can't be resolved statically and
# fails too: a gate must not pass something it could not check.
#
# `make -n` executes no recipe lines. It does evaluate $(shell ...) in variable
# assignments, so a deploy Makefile must not put an AWS call in one (spore-bot's
# only $(shell) is `git describe`).
#
# Fails if:
#   - no Makefile with a deploy target is found (discovery broke — a gate that
#     checks nothing must not pass),
#   - `make -n deploy` fails or prints no commands for one of them, or
#   - any referenced file is missing.
#
# Usage: scripts/check-deploy-paths.sh [root-dir]
set -euo pipefail

root="${1:-$(git rev-parse --show-toplevel)}"
cd "$root" || { echo "::error::root dir $root not found"; exit 1; }

makefiles=()
while IFS= read -r f; do
  grep -qE '^deploy:' "$f" && makefiles+=("$f")
done < <(find . -name Makefile -not -path '*/node_modules/*' -not -path './.git/*' | sort)

if [ "${#makefiles[@]}" -eq 0 ]; then
  echo "::error::no Makefile with a deploy: target found under $root"
  exit 1
fi

bad=0
for mf in "${makefiles[@]}"; do
  dir="$(dirname "$mf")"
  # MAKEFLAGS/MAKELEVEL cleared so a caller's make (e.g. running this from a
  # Makefile) can't leak -k, -i or a jobserver into the dry run.
  if ! cmds="$(cd "$dir" && env -u MAKEFLAGS -u MAKELEVEL make --no-print-directory -n deploy 2>&1)"; then
    echo "::error file=$mf::make -n deploy failed:"
    printf '%s\n' "$cmds" | sed 's/^/    /'
    bad=1
    continue
  fi
  # make says "Nothing to be done" rather than printing nothing for an empty recipe.
  cmds="$(printf '%s\n' "$cmds" | grep -vE "^(g?make(\[[0-9]+\])?: )?Nothing to be done for" || true)"
  if [ -z "$(printf '%s' "$cmds" | tr -d '[:space:]')" ]; then
    echo "::error file=$mf::make -n deploy printed no commands"
    bad=1
    continue
  fi

  # One candidate path per line. Joined continuation lines are split on
  # whitespace, ;, quotes and backticks; flag=value forms are split on =.
  refs="$(printf '%s\n' "$cmds" | tr ' \t;"`'"'" '\n' | awk '
    prev_flag { print; prev_flag = 0; next }
    /^--(template-file|cli-input-json|cli-input-yaml)$/ { prev_flag = 1; next }
    /^--(template-file|cli-input-json|cli-input-yaml)=/ { sub(/^[^=]*=/, ""); print; next }
    /fileb?:\/\// { sub(/^.*fileb?:\/\//, ""); print; next }
    /:\/\// { next }  # s3://, https:// — remote, not a local file
    /\.(ya?ml|json|sh|py|tf|tpl)$/ { sub(/^[^=]*=/, ""); print }
  ' | sort -u)"

  n=0
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    n=$((n + 1))
    case "$ref" in
      *'$'*)
        echo "::error file=$mf::deploy references $ref, which is built from a shell variable and cannot be checked"
        bad=1 ;;
      /*)
        [ -e "$ref" ] || { echo "::error file=$mf::deploy references $ref, which does not exist"; bad=1; } ;;
      *)
        [ -e "$dir/$ref" ] || { echo "::error file=$mf::deploy references $ref (resolved: $dir/$ref), which does not exist"; bad=1; } ;;
    esac
  done <<< "$refs"
  echo "$mf: deploy has $(printf '%s\n' "$cmds" | grep -c .) command line(s), $n file reference(s) checked"
done

if [ "$bad" -ne 0 ]; then
  echo "A deploy target references a file that is not in this checkout (see #570)."
  exit 1
fi
echo "All ${#makefiles[@]} deploy target(s) reference only files that exist"
