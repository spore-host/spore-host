#!/usr/bin/env bash
# Check that the current branch is a clean, single-topic branch off origin/main
# before you open a PR.
#
# This exists because of a specific failure, not as a style preference. PR #521
# (a CI-runner fix) was branched from a working tree that still held PR #519's
# portal commit, so #521's head contained BOTH changes. #521 merged first and
# carried the portal fix with it; #519 then merged as an EMPTY commit (131f02b).
#
# The damage wasn't cosmetic. deploy-site.yaml and web-ci.yml are path-filtered on
# `web/**`, so an empty merge commit matched neither: the PR whose entire purpose
# was fixing two user-facing strings produced no Web CI run and no site deploy,
# and it took a bundle-level audit of what was actually being served to establish
# whether the fix was live at all.
#
# Both symptoms — the empty commit and the swept-in unrelated files — come from
# one root cause: branching off a dirty HEAD instead of off origin/main. That is
# mechanically detectable, which is what this script does.
#
# Usage:  scripts/branch-preflight.sh          # check the current branch
#         scripts/branch-preflight.sh --fix    # print the commands to fix it
set -uo pipefail

fail=0
FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

say()  { printf '%s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=1; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }

branch="$(git rev-parse --abbrev-ref HEAD)"
say "branch-preflight: $branch"

# ── 1. Not on main ───────────────────────────────────────────────────────────
# main auto-deploys (deploy-site.yaml on web/**, docs.yaml on docs/**), so a
# commit made directly here publishes without ever having been a PR.
if [ "$branch" = "main" ]; then
  bad "you are on main — main auto-deploys; work on a topic branch"
else
  ok "not on main"
fi

# ── 2. Clean tree ────────────────────────────────────────────────────────────
# A dirty tree is how unrelated files get swept into a commit. It happened in
# this repo: two infra/ci-runners/ files landed in a portal commit and had to be
# unstaged after the fact.
if [ -n "$(git status --porcelain)" ]; then
  bad "working tree is dirty — commit, stash, or restore before opening a PR:"
  git status --short | sed 's/^/          /'
else
  ok "working tree clean"
fi

git fetch origin main --quiet 2>/dev/null || warn "could not fetch origin/main — comparing against a possibly stale ref"

# ── 3. Branched off origin/main ──────────────────────────────────────────────
# The load-bearing check. If the merge-base isn't an ancestor of origin/main,
# this branch was cut from someone else's work (or your own unmerged work) and
# will carry their commits into your PR.
base="$(git merge-base HEAD origin/main 2>/dev/null)"
if [ -z "$base" ]; then
  bad "no merge-base with origin/main — is this branch related to main at all?"
elif ! git merge-base --is-ancestor "$base" origin/main; then
  bad "merge-base ${base:0:7} is not an ancestor of origin/main"
else
  behind=$(git rev-list --count "$base..origin/main")
  # Being behind is fine and normal under squash-merge — it is NOT an error.
  # It is only worth naming because it's the condition under which two PRs
  # touching the same files silently overlap.
  if [ "$behind" -gt 0 ]; then
    ok "based on origin/main history (${behind} commit(s) behind tip — fine for squash-merge)"
  else
    ok "based on origin/main tip"
  fi
fi

# ── 4. Only your own commits ─────────────────────────────────────────────────
# The check that would have caught #521. Every commit unique to this branch must
# be absent from origin/main. If a commit here belongs to another in-flight PR,
# that PR's content ships under YOUR PR number — and theirs merges empty.
extra=$(git rev-list --count "origin/main..HEAD" 2>/dev/null || echo 0)
if [ "$extra" -eq 0 ]; then
  warn "no commits yet on this branch"
else
  ok "$extra commit(s) ahead of origin/main"
  # Commits reachable from HEAD but not origin/main that ALSO appear on another
  # local or remote branch are the tell: shared, not yours alone.
  #
  # This branch's own remote-tracking ref is not "another branch": once pushed,
  # origin/<branch> contains every commit here, so counting it made the check
  # fail on every re-run for an open PR (#565). Drop the configured upstream
  # (whatever it is named) and origin/<branch>. CI's branch-hygiene job does the
  # stricter check against other open PRs' heads, so nothing is lost.
  self_refs="$branch
origin/$branch"
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  [ -n "$upstream" ] && self_refs="$self_refs
$upstream"
  shared=""
  while read -r c; do
    [ -z "$c" ] && continue
    # origin/HEAD is listed as "origin" by newer git's %(refname:short).
    others=$(git branch -a --contains "$c" --format='%(refname:short)' 2>/dev/null \
      | grep -vxF "$self_refs" | grep -vxE 'origin/HEAD|origin' | tr '\n' ' ')
    [ -n "$others" ] && shared="${shared}          ${c:0:7} $(git log -1 --format=%s "$c") → also on: $others
"
  done < <(git rev-list "origin/main..HEAD")
  if [ -n "$shared" ]; then
    bad "commits on this branch also live on other branches (another PR's work?):"
    printf '%s' "$shared"
  else
    ok "every commit is unique to this branch"
  fi
fi

# ── 5. Single topic ──────────────────────────────────────────────────────────
# Advisory only — a legitimately cross-cutting change exists. But a PR spanning
# web/ AND infra/ AND lambda/ is usually the dirty-tree symptom, not a design.
if [ "$extra" -gt 0 ]; then
  # Top-level DIRECTORIES only. Counting root files too made this fire on a
  # perfectly coherent change that happened to touch CHANGELOG.md + CLAUDE.md +
  # CONTRIBUTING.md — a warning that cries wolf on the common case gets ignored,
  # which is worse than not having it.
  areas=$(git diff --name-only origin/main...HEAD 2>/dev/null \
    | awk -F/ 'NF>1 {print $1}' | sort -u | tr '\n' ' ')
  n=$(printf '%s' "$areas" | wc -w | tr -d ' ')
  if [ "$n" -gt 3 ]; then
    warn "touches $n top-level areas ($areas) — is this one topic?"
  elif [ "$n" -gt 0 ]; then
    ok "touches: $areas"
  else
    # Only root-level files (CHANGELOG.md, CONTRIBUTING.md, …). Say so rather than
    # reporting "nothing", which reads as a broken check on a real diff.
    ok "touches: root files only"
  fi
fi

say ""
if [ "$fail" -ne 0 ]; then
  say "branch-preflight: FAILED"
  if [ "$FIX" -eq 1 ]; then
    say ""
    say "To recut this branch cleanly from origin/main, keeping only your own work:"
    say "  git fetch origin main"
    say "  git stash                      # if the tree is dirty"
    say "  git checkout -b ${branch}-clean origin/main"
    say "  git cherry-pick <your-sha>...  # only YOUR commits"
    say "  git stash pop                  # if you stashed"
  else
    say "Re-run with --fix to print recovery commands."
  fi
  exit 1
fi
say "branch-preflight: ok — safe to open a PR"
