#!/usr/bin/env bash
# Tests for scripts/branch-preflight.sh, run against throwaway repositories with
# a local bare repo as `origin`. No network, no credentials.
#
# Usage:  scripts/test-branch-preflight.sh
#
# The case that motivated it (#565): once a branch was pushed, its own
# origin/<branch> contained every commit, so check 4 reported them as "also on
# another branch" and the preflight could never pass on an open PR.
set -uo pipefail

PREFLIGHT="$(cd "$(dirname "$0")" && pwd)/branch-preflight.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

# Isolate from the caller's git config (hooks, signing, default branch, …).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=preflight-test GIT_AUTHOR_EMAIL=preflight-test@example.invalid
export GIT_COMMITTER_NAME=preflight-test GIT_COMMITTER_EMAIL=preflight-test@example.invalid

failures=0
n=0

# setup: a bare origin with one commit on main, cloned into $ROOT/<name>/work.
setup() {
  local d="$ROOT/$1"
  mkdir -p "$d"
  git init -q --bare -b main "$d/origin.git"
  git init -q -b main "$d/seed"
  (cd "$d/seed" && echo base > base.txt && git add base.txt && git commit -qm base \
    && git remote add origin "$d/origin.git" && git push -q origin main)
  git clone -q "$d/origin.git" "$d/work"
  cd "$d/work" || exit 1
}

commit() { echo "$1" > "$1.txt" && git add "$1.txt" && git commit -qm "$1"; }

# expect <ok|fail> <description> [text the output must contain] [text it must not]
expect() {
  local want="$1" desc="$2" pat="${3:-}" notpat="${4:-}" out rc got
  n=$((n + 1))
  out="$("$PREFLIGHT" 2>&1)"; rc=$?
  got=ok; [ "$rc" -ne 0 ] && got=fail
  if [ "$got" != "$want" ]; then
    printf 'FAIL  %s: preflight returned %s, want %s\n%s\n' "$desc" "$got" "$want" "$(printf '%s\n' "$out" | sed 's/^/      /')"
    failures=$((failures + 1))
  elif [ -n "$pat" ] && ! printf '%s' "$out" | grep -qF -- "$pat"; then
    printf 'FAIL  %s: output lacks %q\n%s\n' "$desc" "$pat" "$(printf '%s\n' "$out" | sed 's/^/      /')"
    failures=$((failures + 1))
  elif [ -n "$notpat" ] && printf '%s' "$out" | grep -qF -- "$notpat"; then
    printf 'FAIL  %s: output contains %q\n%s\n' "$desc" "$notpat" "$(printf '%s\n' "$out" | sed 's/^/      /')"
    failures=$((failures + 1))
  else
    printf 'ok    %s\n' "$desc"
  fi
}

# 1. #565: pushed with -u. origin/fix/a is this branch, not another one.
setup pushed-upstream
git checkout -q -b fix/a origin/main && commit a && git push -q -u origin fix/a
expect ok "pushed branch with upstream passes (#565)"
commit a2 && git push -q
expect ok "follow-up commit on a pushed branch passes (#565)"

# 2. Pushed without -u: origin/<branch> exists but no upstream is configured.
setup pushed-no-upstream
git checkout -q -b fix/b origin/main && commit b && git push -q origin fix/b
expect ok "pushed branch without upstream passes"

# 3. Upstream named differently from the branch.
setup renamed-upstream
git checkout -q -b local-name origin/main && commit c && git push -q -u origin local-name:fix/remote-name
expect ok "branch whose upstream has a different name passes"

# 4. Cut from another pushed, unmerged branch: the #521 failure. Must still fail,
#    and name the other branch, even though this branch is pushed too.
setup cut-from-pushed-other
git checkout -q -b fix/other origin/main && commit other && git push -q -u origin fix/other
git checkout -q -b fix/mine && commit mine && git push -q -u origin fix/mine
expect fail "branch carrying another pushed branch's commit fails" "origin/fix/other" "origin/fix/mine"

# 5. Same, the other branch only local.
setup cut-from-local-other
git checkout -q -b fix/other origin/main && commit other
git checkout -q -b fix/mine && commit mine
expect fail "branch carrying another local branch's commit fails" "also on: fix/other"

# 6. On main.
setup on-main
expect fail "on main fails" "you are on main"

# 7. Dirty tree.
setup dirty
git checkout -q -b fix/d origin/main && commit d && echo x > untracked.txt
expect fail "dirty tree fails" "working tree is dirty"

echo
if [ "$failures" -ne 0 ]; then
  echo "test-branch-preflight: $failures of $n FAILED"
  exit 1
fi
echo "test-branch-preflight: all $n passed"
