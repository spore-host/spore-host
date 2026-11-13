#!/usr/bin/env python3
"""Tests for check_oidc_trusts.py. No AWS; throwaway files only.

Usage:  python3 -I scripts/test_check_oidc_trusts.py
"""

import copy
import json
import pathlib
import sys
import tempfile
import unittest
from urllib.parse import quote

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import check_oidc_trusts as c  # noqa: E402

H = c.HOST
ACCT = "966362334030"


def trust(cond, acct=ACCT):
    return {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow",
        "Principal": {"Federated": f"arn:aws:iam::{acct}:oidc-provider/{H}"},
        "Action": "sts:AssumeRoleWithWebIdentity",
        "Condition": cond}]}


GOOD = trust({"StringEquals": {f"{H}:aud": "sts.amazonaws.com", f"{H}:sub": "repo:spore-host/spore-host:ref:refs/heads/main"}})


class Lint(unittest.TestCase):
    def test_good(self):
        self.assertEqual(c.lint_trust("r", ACCT, GOOD), [])

    def test_tag_pattern_allowed(self):
        t = trust({"StringEquals": {f"{H}:aud": "sts.amazonaws.com"}, "StringLike": {f"{H}:sub": "repo:spore-host/spawn:ref:refs/tags/v*"}})
        self.assertEqual(c.lint_trust("r", ACCT, t), [])

    def bad(self, t, acct=ACCT):
        errs = c.lint_trust("r", acct, t)
        self.assertTrue(errs, json.dumps(t))
        return errs

    def test_wildcard_repo_sub(self):
        self.bad(trust({"StringEquals": {f"{H}:aud": "sts.amazonaws.com"}, "StringLike": {f"{H}:sub": "repo:spore-host/spore-host:*"}}))
        self.bad(trust({"StringEquals": {f"{H}:aud": "sts.amazonaws.com"}, "StringLike": {f"{H}:sub": "repo:spore-host/*"}}))

    def test_branch_wildcard(self):
        self.bad(trust({"StringEquals": {f"{H}:aud": "sts.amazonaws.com"}, "StringLike": {f"{H}:sub": "repo:spore-host/spore-host:ref:refs/heads/*"}}))

    def test_pull_request_sub(self):
        self.bad(trust({"StringEquals": {f"{H}:aud": "sts.amazonaws.com", f"{H}:sub": "repo:spore-host/spore-host:pull_request"}}))

    def test_aud_only(self):
        errs = self.bad(trust({"StringEquals": {f"{H}:aud": "sts.amazonaws.com"}}))
        self.assertTrue(any("no sub" in e for e in errs))

    def test_missing_aud(self):
        self.bad(trust({"StringEquals": {f"{H}:sub": "repo:spore-host/spore-host:ref:refs/heads/main"}}))

    def test_provider_in_another_account(self):
        self.bad(GOOD, acct="435415984226")

    def test_forbidden_account(self):
        t = copy.deepcopy(GOOD)
        t["Statement"][0]["Principal"]["Federated"] = f"arn:aws:iam::942542972736:oidc-provider/{H}"
        errs = self.bad(t, acct="942542972736")
        self.assertTrue(any("forbidden" in e for e in errs))

    def test_non_github_principal(self):
        t = copy.deepcopy(GOOD)
        t["Statement"][0]["Principal"] = {"AWS": "arn:aws:iam::123456789012:root"}
        self.bad(t)


class Live(unittest.TestCase):
    def run_live(self, doc):
        inv = {"roles": [{"role": "R", "account": ACCT, "trust": GOOD}]}
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / "role.json"
            p.write_text(json.dumps({"Role": {"AssumeRolePolicyDocument": doc}}))
            return c.live_check(inv, [f"R={p}"])

    def test_match(self):
        self.assertEqual(self.run_live(GOOD), [])

    def test_match_url_encoded_and_reordered(self):
        t = copy.deepcopy(GOOD)
        t["Statement"][0]["Sid"] = "x"
        t["Statement"][0]["Action"] = ["sts:AssumeRoleWithWebIdentity"]
        self.assertEqual(self.run_live(quote(json.dumps(t))), [])

    def test_drift(self):
        t = trust({"StringEquals": {f"{H}:aud": "sts.amazonaws.com"}, "StringLike": {f"{H}:sub": "repo:spore-host/spore-host:*"}})
        errs = self.run_live(t)
        self.assertTrue(any("differs" in e for e in errs))
        self.assertTrue(any("StringLike" in e for e in errs))

    def test_extra_statement(self):
        t = copy.deepcopy(GOOD)
        t["Statement"].append(copy.deepcopy(GOOD["Statement"][0]))
        t["Statement"][1]["Condition"]["StringEquals"][f"{H}:sub"] = "repo:spore-host/other:ref:refs/heads/main"
        self.assertTrue(self.run_live(t))


class Static(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.wf = self.root / ".github" / "workflows"
        self.wf.mkdir(parents=True)
        self.inv = {"roles": [
            {"role": "Deploy", "account": ACCT, "role_arn": f"arn:aws:iam::{ACCT}:role/Deploy", "variables": [],
             "used_by": ["spore-host/spore-host:.github/workflows/d.yml"], "codified_in": None, "trust": GOOD},
            {"role": "Prod", "account": ACCT, "role_arn": None, "variables": ["vars.PROD_ROLE"],
             "used_by": ["spore-host/spore-host:.github/workflows/p.yml"], "codified_in": None,
             "trust": trust({"StringEquals": {f"{H}:aud": "sts.amazonaws.com", f"{H}:sub": "repo:spore-host/spore-host:environment:production"}})},
        ]}

    def write(self, name, body):
        (self.wf / name).write_text(body)

    def check(self):
        return c.static_check(self.inv, self.wf, self.root)

    def test_ok(self):
        self.write("d.yml", f"on:\n  push:\n    branches: [main]\njobs:\n  a:\n    steps:\n      - uses: x\n        with:\n          role-to-assume: arn:aws:iam::{ACCT}:role/Deploy\n")
        self.write("p.yml", "on:\n  workflow_dispatch:\njobs:\n  a:\n    environment: production\n    env:\n      R: ${{ vars.PROD_ROLE }}\n    steps:\n      - uses: x\n        with:\n          role-to-assume: ${{ env.R }}\n")
        self.assertEqual(self.check(), [])

    def test_unknown_role(self):
        self.write("d.yml", "on:\n  push:\njobs:\n  a:\n    steps:\n      - uses: x\n        with:\n          role-to-assume: arn:aws:iam::111111111111:role/Other\n")
        self.assertTrue(any("not in" in e for e in self.check()))

    def test_pull_request(self):
        self.write("d.yml", f"on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - uses: x\n        with:\n          role-to-assume: arn:aws:iam::{ACCT}:role/Deploy\n")
        self.assertTrue(any("pull_request" in e for e in self.check()))

    def test_environment_mismatch(self):
        self.write("d.yml", f"on:\n  push:\njobs:\n  a:\n    environment:\n      name: staging\n    steps:\n      - uses: x\n        with:\n          role-to-assume: arn:aws:iam::{ACCT}:role/Deploy\n")
        self.assertTrue(any("environment staging" in e for e in self.check()))

    def test_environment_resets_per_job(self):
        self.write("p.yml", "on:\n  workflow_dispatch:\njobs:\n  a:\n    environment: production\n    steps: []\n  b:\n    steps:\n      - with:\n          role-to-assume: ${{ vars.PROD_ROLE }}\n")
        self.assertTrue(any("no environment" in e for e in self.check()))

    def test_this_repo(self):
        self.assertEqual(c.main([]), 0)


if __name__ == "__main__":
    unittest.main()
