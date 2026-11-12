#!/usr/bin/env python3
"""Check the IAM policy JSON blocks in the docs.

Every ```json block in each file given (default: docs/reference/iam-permissions.md
and SECURITY.md) must parse. Each policy or statement found in them must also hold
these invariants:

  1. No `${aws:PrincipalAccount}` in a Resource or NotResource. IAM's
     PutRolePolicy rejects it there ("failed legacy parsing") even though Access
     Analyzer and the policy simulator accept it, so a doc using it hands out a
     policy that can't be applied (spawn#1069).
  2. No Allow of ec2:CreateTags without a condition. Unconditioned, it lets the
     holder add spawn:managed=true to any resource, and every grant scoped by
     that tag stops being scoped.
  3. No Allow of an IAM role write (CreateRole, PutRolePolicy, AttachRolePolicy,
     PutRolePermissionsBoundary) unless the statement is conditioned on
     iam:PermissionsBoundary. The role-name patterns limit which roles can be
     written, not what is written onto them; the boundary is the containment.
  4. No Allow of iam:DeleteRolePermissionsBoundary, iam:CreatePolicyVersion or
     iam:SetDefaultPolicyVersion.

A wildcard action ("*", "ec2:*", "iam:*", "iam:Put*", ...) counts as every action
it matches.

With no arguments it also checks each CloudFormation template in
deployment/cloudformation/ that trusts an AWS principal: it must carry the Rules
assertion refusing AWS::AccountId 942542972736 (spawn#1582).

Exit status 1 lists each violation with its file and block.

Usage:  scripts/check_iam_doc_policies.py [FILE ...]
"""

import fnmatch
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_FILES = [REPO / "docs/reference/iam-permissions.md", REPO / "SECURITY.md"]

TEMPLATES = REPO / "deployment/cloudformation"
FORBIDDEN_ACCOUNT = "942542972736"

FENCE = re.compile(r"^```json[^\n]*\n(.*?)^```", re.M | re.S)

ROLE_WRITES = [
    "iam:CreateRole",
    "iam:PutRolePolicy",
    "iam:AttachRolePolicy",
    "iam:PutRolePermissionsBoundary",
]
NEVER_ALLOWED = [
    "iam:DeleteRolePermissionsBoundary",
    "iam:CreatePolicyVersion",
    "iam:SetDefaultPolicyVersion",
]


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def grants(stmt, action):
    """Whether the statement's Action (or NotAction) covers action."""
    if "NotAction" in stmt:
        return not any(fnmatch.fnmatchcase(action.lower(), p.lower()) for p in as_list(stmt["NotAction"]))
    return any(fnmatch.fnmatchcase(action.lower(), p.lower()) for p in as_list(stmt.get("Action")))


def condition_keys(stmt):
    keys = set()
    for _op, body in (stmt.get("Condition") or {}).items():
        if isinstance(body, dict):
            keys.update(k.lower() for k in body)
    return keys


def statements(doc):
    """The statements in a parsed block: a policy, a statement list, or one statement."""
    if isinstance(doc, list):
        return [s for s in doc if isinstance(s, dict)]
    if not isinstance(doc, dict):
        return []
    if "Statement" in doc:
        return [s for s in as_list(doc["Statement"]) if isinstance(s, dict)]
    if "Action" in doc or "NotAction" in doc:
        return [doc]
    return []


def check_statement(stmt):
    problems = []
    sid = stmt.get("Sid", "(no Sid)")
    for field in ("Resource", "NotResource"):
        for r in as_list(stmt.get(field)):
            if isinstance(r, str) and "${aws:PrincipalAccount}" in r:
                problems.append(f"{sid}: ${{aws:PrincipalAccount}} in {field} ({r}); PutRolePolicy rejects it")
    # A fragment with no Effect is shown to be pasted as an Allow.
    if stmt.get("Effect", "Allow") != "Allow":
        return problems
    conds = condition_keys(stmt)
    if grants(stmt, "ec2:CreateTags") and not conds:
        problems.append(f"{sid}: allows ec2:CreateTags with no condition")
    for a in ROLE_WRITES:
        if grants(stmt, a) and "iam:permissionsboundary" not in conds:
            problems.append(f"{sid}: allows {a} without an iam:PermissionsBoundary condition")
    for a in NEVER_ALLOWED:
        if grants(stmt, a):
            problems.append(f"{sid}: allows {a}")
    return problems


def check_text(text, label):
    problems = []
    for i, m in enumerate(FENCE.finditer(text), 1):
        line = text.count("\n", 0, m.start()) + 1
        where = f"{label}:{line} (json block {i})"
        try:
            doc = json.loads(m.group(1))
        except json.JSONDecodeError as e:
            problems.append(f"{where}: does not parse: {e}")
            continue
        for s in statements(doc):
            problems.extend(f"{where}: {p}" for p in check_statement(s))
    return problems


TRUSTS_AWS_PRINCIPAL = re.compile(r"Principal:\s*\n\s*AWS:|Principal:\s*\{\s*AWS:")
ACCOUNT_RULE = re.compile(
    r"^Rules:.*?Assert:\s*!Not\s*\[\s*!Equals\s*\[\s*!Ref\s*'AWS::AccountId'\s*,\s*'" + FORBIDDEN_ACCOUNT + "'",
    re.M | re.S,
)


def check_template(text, label):
    """A template whose role trusts an AWS principal must refuse the forbidden account."""
    if TRUSTS_AWS_PRINCIPAL.search(text) and not ACCOUNT_RULE.search(text):
        return [f"{label}: trusts an AWS principal but has no Rules assertion refusing AWS::AccountId {FORBIDDEN_ACCOUNT}"]
    return []


def main(argv):
    files = [Path(a) for a in argv] or DEFAULT_FILES
    problems = []
    if not argv:
        for t in sorted(TEMPLATES.glob("*.y*ml")):
            problems.extend(check_template(t.read_text(encoding="utf-8"), str(t.relative_to(REPO))))
    for f in files:
        try:
            label = str(f.resolve().relative_to(REPO))
        except ValueError:
            label = str(f)
        problems.extend(check_text(f.read_text(encoding="utf-8"), label))
    for p in problems:
        print(f"::error::{p}")
    if problems:
        print(f"{len(problems)} problem(s) in the docs' IAM policy blocks.")
        return 1
    print(f"IAM policy blocks OK in {len(files)} file(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
