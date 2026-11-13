#!/usr/bin/env python3
"""Check the GitHub Actions OIDC trusts spore.host's CI roles must have (#709).

infra/iam/github-oidc/trusts.json lists every AWS role a spore.host workflow
assumes and the trust policy it must carry. Most of those trusts were made by
hand and exist in no IaC, so code review can't see whether one trusts a
wildcard `sub`, which would let any branch, pull request or repository in the
org assume it. This script turns the inventory into something checked.

Static mode (CI, no AWS):
  - every expected trust is well-formed: GitHub's OIDC provider in the role's
    own account, sts:AssumeRoleWithWebIdentity, `aud` StringEquals
    sts.amazonaws.com, and `sub` StringEquals one exact ref or environment of
    one named repository. The only StringLike allowed is a tag pattern
    (repo:<org>/<repo>:ref:refs/tags/<pattern>), for a tag-triggered release;
  - no expected trust names 942542972736;
  - every role a workflow in THIS repo assumes (`role-to-assume:`) is in the
    inventory, either as a literal ARN or by the variable it comes from;
  - a workflow here that assumes a role does not run on pull_request, and a
    job's `environment:` agrees with the trust's sub;
  - a trust marked as codified in this repo's tofu has the same sub there.

Live mode (run by a person with read access to IAM; this script makes no
AWS call itself):
  aws iam get-role --role-name GitHubActionsDocsDeployRole > docs-role.json
  python3 -I scripts/check_oidc_trusts.py --live GitHubActionsDocsDeployRole=docs-role.json
compares the live AssumeRolePolicyDocument with the expected one, statement
by statement and condition by condition, and lints it with the same rules.

Usage:  python3 -I scripts/check_oidc_trusts.py [--live ROLE=get-role.json ...]
"""

import json
import pathlib
import re
import sys
from urllib.parse import unquote

ROOT = pathlib.Path(__file__).resolve().parent.parent
INVENTORY = ROOT / "infra" / "iam" / "github-oidc" / "trusts.json"
WORKFLOWS = ROOT / ".github" / "workflows"
THIS_REPO = "spore-host/spore-host"
HOST = "token.actions.githubusercontent.com"
FORBIDDEN = {"942542972736"}

SUB_EXACT = re.compile(r"^repo:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+:(ref:refs/(heads|tags)/[A-Za-z0-9_./-]+|environment:[A-Za-z0-9_.-]+)$")
SUB_TAG_PATTERN = re.compile(r"^repo:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+:ref:refs/tags/[A-Za-z0-9_./*-]+$")


def as_list(v):
    return v if isinstance(v, list) else [v]


def lint_trust(name, account, doc):
    """Problems with a trust policy document, expected or live."""
    errs = []
    if FORBIDDEN & set(re.findall(r"\d{12}", json.dumps(doc))):
        errs.append(f"{name}: names a forbidden account (spawn#1582)")
    stmts = as_list(doc.get("Statement", []))
    if not stmts:
        errs.append(f"{name}: no statements")
    for i, s in enumerate(stmts):
        where = f"{name} statement {i}"
        if s.get("Effect") != "Allow":
            continue
        fed = as_list((s.get("Principal") or {}).get("Federated", []))
        if not any(f.endswith(f":oidc-provider/{HOST}") for f in fed):
            errs.append(f"{where}: trusts something other than GitHub's OIDC provider: {s.get('Principal')}")
            continue
        for f in fed:
            if account and not f.startswith(f"arn:aws:iam::{account}:"):
                errs.append(f"{where}: OIDC provider {f} is not in the role's account {account}")
        if as_list(s.get("Action")) != ["sts:AssumeRoleWithWebIdentity"]:
            errs.append(f"{where}: Action must be exactly sts:AssumeRoleWithWebIdentity, is {s.get('Action')}")
        cond = s.get("Condition") or {}
        eq = cond.get("StringEquals", {})
        like = cond.get("StringLike", {})
        for op in cond:
            if op not in ("StringEquals", "StringLike"):
                errs.append(f"{where}: unexpected condition operator {op}")
        if as_list(eq.get(f"{HOST}:aud", [])) != ["sts.amazonaws.com"]:
            errs.append(f"{where}: aud must be StringEquals sts.amazonaws.com")
        if f"{HOST}:aud" in like:
            errs.append(f"{where}: aud must not be StringLike")
        subs_eq = as_list(eq.get(f"{HOST}:sub", []))
        subs_like = as_list(like.get(f"{HOST}:sub", []))
        if not subs_eq and not subs_like:
            errs.append(f"{where}: no sub condition: ANY repository's workflow could assume it")
        for sub in subs_eq:
            if not SUB_EXACT.match(sub):
                errs.append(f"{where}: sub {sub!r} is not one exact ref or environment of one repository")
        for sub in subs_like:
            if not SUB_TAG_PATTERN.match(sub):
                errs.append(f"{where}: StringLike sub {sub!r} is allowed only as a tag pattern (ref:refs/tags/...)")
        extra = {k for k in eq if k not in (f"{HOST}:aud", f"{HOST}:sub")} | {k for k in like if k != f"{HOST}:sub"}
        if extra:
            errs.append(f"{where}: unexpected condition keys {sorted(extra)}; add them to the inventory if intended")
    return errs


def subs_of(doc):
    out = set()
    for s in as_list(doc.get("Statement", [])):
        cond = s.get("Condition") or {}
        for op in ("StringEquals", "StringLike"):
            out |= set(as_list(cond.get(op, {}).get(f"{HOST}:sub", [])))
    return out


def workflow_roles(text):
    """[(role reference, line number, job environment or None)] in a workflow."""
    out, env, in_jobs, pending_env = [], None, False, False
    for n, line in enumerate(text.splitlines(), 1):
        if re.match(r"^jobs:\s*$", line):
            in_jobs = True
            continue
        if in_jobs and re.match(r"^  [A-Za-z0-9_-]+:\s*$", line):
            env, pending_env = None, False  # a new job
            continue
        m = re.match(r"^\s+environment:\s*([^\s#]*)", line)
        if m:
            env, pending_env = (m.group(1).strip("'\"") or None), not m.group(1)
            continue
        m = re.match(r"^\s+name:\s*([^\s#]+)", line)
        if pending_env and m:
            env, pending_env = m.group(1).strip("'\""), False
            continue
        m = re.match(r"^\s+role-to-assume:\s*([^#]+?)\s*(#.*)?$", line)
        if m:
            out.append((m.group(1), n, env))
    return out


def resolve_ref(ref, text):
    """A role-to-assume value as an ARN, or as the vars./secrets. name it comes from."""
    m = re.match(r"^\$\{\{\s*env\.([A-Z0-9_]+)\s*\}\}$", ref)
    if m:
        d = re.search(rf"^\s+{m.group(1)}:\s*(.+)$", text, re.M)
        ref = d.group(1).strip() if d else ref
    m = re.match(r"^\$\{\{\s*(vars|secrets)\.([A-Z0-9_]+)\s*\}\}$", ref)
    if m:
        return f"{m.group(1)}.{m.group(2)}"
    return ref


def static_check(inv, workflows_dir, root):
    errs = []
    roles = inv["roles"]
    for r in roles:
        errs += lint_trust(r["role"], r["account"], r["trust"])
        if r.get("role_arn") and not r["role_arn"].startswith(f"arn:aws:iam::{r['account']}:role/"):
            errs.append(f"{r['role']}: role_arn is not in account {r['account']}")
        codified = r.get("codified_in") or ""
        if codified and ":" not in codified:  # this repo
            path = root / codified
            if not path.exists():
                errs.append(f"{r['role']}: codified_in {codified} does not exist")
            else:
                text = path.read_text()
                for sub in subs_of(r["trust"]):
                    if f'"{sub}"' not in text:
                        errs.append(f"{r['role']}: {codified} does not carry sub {sub}")

    known = {}
    for r in roles:
        for key in [r.get("role_arn")] + r.get("variables", []):
            if key:
                known[key] = r
    for wf in sorted(list(workflows_dir.glob("*.yml")) + list(workflows_dir.glob("*.yaml"))):
        text = wf.read_text()
        uses = workflow_roles(text)
        if not uses:
            continue
        if re.search(r"^\s*pull_request(_target)?\s*:", text, re.M):
            errs.append(f"{wf.name}: assumes an AWS role but runs on pull_request")
        for ref, n, env in uses:
            key = resolve_ref(ref, text)
            r = known.get(key)
            if r is None:
                errs.append(f"{wf.name}:{n}: role {key} is not in {INVENTORY.relative_to(ROOT)}")
                continue
            if f"{THIS_REPO}:.github/workflows/{wf.name}" not in r["used_by"]:
                errs.append(f"{wf.name}:{n}: {r['role']}'s used_by does not list this workflow")
            subs = subs_of(r["trust"])
            if env and f"repo:{THIS_REPO}:environment:{env}" not in subs:
                errs.append(f"{wf.name}:{n}: job runs in environment {env}, but {r['role']} trusts {sorted(subs)}")
            if not env and not any(s.startswith(f"repo:{THIS_REPO}:ref:") for s in subs):
                errs.append(f"{wf.name}:{n}: job has no environment, but {r['role']} trusts only {sorted(subs)}")
    return errs


def normalize(doc):
    """A trust document in a canonical, comparable form."""
    if isinstance(doc, str):
        doc = json.loads(unquote(doc))
    stmts = []
    for s in as_list(doc.get("Statement", [])):
        s = dict(s)
        s.pop("Sid", None)
        if "Action" in s:
            s["Action"] = sorted(as_list(s["Action"]))
        p = s.get("Principal") or {}
        s["Principal"] = {k: sorted(as_list(v)) for k, v in p.items()} if isinstance(p, dict) else p
        s["Condition"] = {op: {k: sorted(as_list(v)) for k, v in kv.items()} for op, kv in (s.get("Condition") or {}).items()}
        stmts.append(s)
    return sorted(stmts, key=lambda x: json.dumps(x, sort_keys=True))


def live_check(inv, pairs):
    errs = []
    by_name = {r["role"]: r for r in inv["roles"]}
    for pair in pairs:
        name, _, path = pair.partition("=")
        r = by_name.get(name)
        if r is None:
            errs.append(f"--live {name}: not in the inventory (names: {', '.join(by_name)})")
            continue
        got = json.loads(pathlib.Path(path).read_text())
        doc = got.get("Role", got).get("AssumeRolePolicyDocument", got)
        live = normalize(doc)
        want = normalize(r["trust"])
        errs += [f"LIVE {e}" for e in lint_trust(name, r["account"], {"Statement": live})]
        if live != want:
            errs.append(f"LIVE {name}: trust differs from the inventory.\n  expected: {json.dumps(want, sort_keys=True)}\n  live:     {json.dumps(live, sort_keys=True)}")
        else:
            print(f"LIVE {name}: matches the inventory")
    return errs


def main(argv):
    inv = json.loads(INVENTORY.read_text())
    pairs, i = [], 0
    while i < len(argv):
        if argv[i] == "--live" and i + 1 < len(argv):
            pairs.append(argv[i + 1])
            i += 2
        elif argv[i].startswith("--live="):
            pairs.append(argv[i].split("=", 1)[1])
            i += 1
        else:
            print(f"unknown argument {argv[i]}", file=sys.stderr)
            return 2
    errs = live_check(inv, pairs) if pairs else static_check(inv, WORKFLOWS, ROOT)
    for e in errs:
        print(f"::error::{e}")
    if errs:
        return 1
    if not pairs:
        print(f"{len(inv['roles'])} expected OIDC trusts are well-formed and cover every role this repo's workflows assume")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
