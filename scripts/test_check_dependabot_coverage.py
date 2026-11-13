#!/usr/bin/env python3
"""Tests for check_dependabot_coverage.py, against throwaway git repos.

Usage:  python3 -I scripts/test_check_dependabot_coverage.py
"""

import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import check_dependabot_coverage as c  # noqa: E402

CONFIG = """version: 2
updates:
  - package-ecosystem: "gomod"
    directories:
      - "/lambda/a"   # comment
      - "/lambda/b"
    schedule:
      interval: "weekly"
  - package-ecosystem: "npm"
    directory: "/web"
  - package-ecosystem: "github-actions"
    directory: "/"
"""


class Coverage(unittest.TestCase):
    def repo(self, files):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        root = pathlib.Path(d.name)
        for f in files:
            (root / f).parent.mkdir(parents=True, exist_ok=True)
            (root / f).write_text("x")
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
        return root

    def test_parse(self):
        self.assertEqual(c.parse_config(CONFIG), [("gomod", "/lambda/a"), ("gomod", "/lambda/b"), ("npm", "/web"), ("github-actions", "/")])

    def test_covered(self):
        root = self.repo(["lambda/a/go.mod", "lambda/b/go.mod", "web/package.json"])
        self.assertEqual(c.check(root, CONFIG, {}), [])

    def test_unwatched_manifest(self):
        root = self.repo(["lambda/a/go.mod", "lambda/b/go.mod", "web/package.json", "lambda/c/go.mod", "docs/package.json"])
        errs = c.check(root, CONFIG, {})
        self.assertEqual(len(errs), 2, errs)

    def test_entry_without_manifest(self):
        root = self.repo(["lambda/a/go.mod", "web/package.json"])
        errs = c.check(root, CONFIG, {})
        self.assertTrue(any("/lambda/b" in e for e in errs), errs)

    def test_manifest_in_a_subdirectory_does_not_count(self):
        root = self.repo(["lambda/a/go.mod", "lambda/b/sub/go.mod", "web/package.json"])
        errs = c.check(root, CONFIG, {})
        self.assertTrue(any("entry for /lambda/b" in e for e in errs), errs)

    def test_needs_actions_entry(self):
        root = self.repo(["web/package.json"])
        cfg = 'version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directory: "/web"\n'
        self.assertTrue(any("github-actions" in e for e in c.check(root, cfg, {})))

    def test_node_modules_ignored(self):
        root = self.repo(["lambda/a/go.mod", "lambda/b/go.mod", "web/package.json", "web/node_modules/x/package.json"])
        self.assertEqual(c.check(root, CONFIG, {}), [])

    def test_stale_exemption_fails(self):
        root = self.repo(["lambda/a/go.mod", "lambda/b/go.mod", "web/package.json"])
        errs = c.check(root, CONFIG, {"gone/pyproject.toml": "reason"})
        self.assertTrue(any("no longer tracked" in e for e in errs), errs)

    def test_this_repo(self):
        self.assertEqual(c.main(["x"]), 0)


if __name__ == "__main__":
    unittest.main()
