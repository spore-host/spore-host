#!/usr/bin/env python3
"""Tests for scripts/check_iam_doc_policies.py. No network, no credentials.

Usage:  python3 scripts/test_check_iam_doc_policies.py
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_iam_doc_policies as c  # noqa: E402

BOUNDARY = {"ArnLike": {"iam:PermissionsBoundary": "arn:aws:iam::*:policy/spore-host/spawn-instance-boundary"}}


def md(*docs):
    return "\n".join("```json\n" + (d if isinstance(d, str) else json.dumps(d, indent=2)) + "\n```\n" for d in docs)


def policy(*stmts):
    return {"Version": "2012-10-17", "Statement": list(stmts)}


def allow(action, resource="*", condition=None, **extra):
    s = {"Effect": "Allow", "Action": action, "Resource": resource, **extra}
    if condition:
        s["Condition"] = condition
    return s


class CheckText(unittest.TestCase):
    def problems(self, *docs):
        return c.check_text(md(*docs), "t.md")

    def assertFlags(self, text, *docs):
        got = self.problems(*docs)
        self.assertTrue(any(text in p for p in got), f"want a problem containing {text!r}, got {got}")

    def assertClean(self, *docs):
        self.assertEqual(self.problems(*docs), [])

    def test_unparseable_block(self):
        self.assertFlags("does not parse", '{"Action": "ec2:RunInstances",}')

    def test_principal_account_in_resource(self):
        self.assertFlags(
            "PrincipalAccount",
            policy(allow("s3:GetObject", "arn:aws:s3:::b-${aws:PrincipalAccount}/*")),
        )

    def test_principal_account_in_condition_is_fine(self):
        self.assertClean(
            policy(allow("s3:GetObject", "*", {"StringEquals": {"aws:ResourceAccount": "${aws:PrincipalAccount}"}}))
        )

    def test_unconditioned_create_tags(self):
        self.assertFlags("ec2:CreateTags with no condition", policy(allow(["ec2:ImportKeyPair", "ec2:CreateTags"])))

    def test_wildcard_covers_create_tags(self):
        self.assertFlags("ec2:CreateTags with no condition", policy(allow("ec2:*")))
        self.assertFlags("ec2:CreateTags with no condition", policy(allow("ec2:Create*")))

    def test_create_tags_on_create(self):
        self.assertClean(policy(allow("ec2:CreateTags", "*", {"StringEquals": {"ec2:CreateAction": "RunInstances"}})))

    def test_bare_statement_fragment_is_checked(self):
        self.assertFlags("ec2:CreateTags with no condition", {"Action": "ec2:CreateTags", "Resource": "*"})

    def test_role_writes_need_the_boundary(self):
        for a in c.ROLE_WRITES:
            with self.subTest(action=a):
                self.assertFlags(f"{a} without", policy(allow(a, "arn:aws:iam::*:role/spawn-instance-*")))
                self.assertClean(policy(allow(a, "arn:aws:iam::*:role/spawn-instance-*", BOUNDARY)))

    def test_policy_arn_alone_is_not_the_boundary(self):
        self.assertFlags(
            "iam:AttachRolePolicy without",
            policy(allow("iam:AttachRolePolicy", "*", {"ArnLike": {"iam:PolicyARN": "arn:aws:iam::*:policy/x/*"}})),
        )

    def test_iam_wildcard(self):
        self.assertFlags("iam:CreateRole without", policy(allow("iam:*")))
        self.assertFlags("iam:PutRolePolicy without", policy(allow("iam:Put*")))

    def test_not_action(self):
        self.assertFlags("iam:CreateRole without", policy(allow(None, "*", NotAction="s3:*")))

    def test_never_allowed(self):
        for a in c.NEVER_ALLOWED:
            with self.subTest(action=a):
                self.assertFlags(f"allows {a}", policy(allow(a, "*", BOUNDARY)))

    def test_deny_statements_are_not_grants(self):
        self.assertClean(
            policy({"Effect": "Deny", "Action": ["ec2:CreateTags", "iam:DeleteRolePermissionsBoundary"], "Resource": "*"})
        )


class CheckTemplate(unittest.TestCase):
    TRUST = "AssumeRolePolicyDocument:\n  Statement:\n    - Principal:\n        AWS: !Ref X\n"
    RULE = "Rules:\n  R:\n    Assertions:\n      - Assert: !Not [!Equals [!Ref 'AWS::AccountId', '942542972736']]\n"

    def test_cross_account_template_without_rule(self):
        self.assertTrue(c.check_template(self.TRUST, "t.yaml"))

    def test_cross_account_template_with_rule(self):
        self.assertEqual(c.check_template(self.RULE + self.TRUST, "t.yaml"), [])

    def test_service_principal_needs_no_rule(self):
        self.assertEqual(c.check_template("Principal: { Service: lambda.amazonaws.com }\n", "t.yaml"), [])


class RepoFiles(unittest.TestCase):
    def test_repo_docs_and_templates_pass(self):
        self.assertEqual(c.main([]), 0)


if __name__ == "__main__":
    unittest.main()
