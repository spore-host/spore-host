#!/usr/bin/env python3
"""Tests for prune_site_bucket.py. No AWS: a stub `aws` on PATH.

Usage:  python3 -I scripts/test_prune_site_bucket.py
"""

import json
import os
import pathlib
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import prune_site_bucket as p  # noqa: E402

PREFIXES = ["assets/", "css/", "app/", "js/"]
REQUIRED = ["index.html", "app/index.html", "css/style.css"]
BUILD = {"index.html", "app/index.html", "css/style.css", "assets/demo.cast", "assets/brand/og.png", "cloudformation/t.yaml"}


class Plan(unittest.TestCase):
    def test_deletes_only_stale_keys_under_managed_prefixes(self):
        keys = sorted(BUILD) + [
            "assets/app-abc123.js", "app/assets/index-x.js", "js/auth.js", "js/main.js",
            "css/old.css", "install.sh", "cloudformation/other.yaml", "robots.txt", "assetsX/keep",
        ]
        stale, err = p.plan(BUILD, keys, PREFIXES, REQUIRED, 500)
        self.assertIsNone(err)
        self.assertEqual(stale, ["app/assets/index-x.js", "assets/app-abc123.js", "css/old.css", "js/auth.js", "js/main.js"])

    def test_never_deletes_a_manifest_key(self):
        stale, err = p.plan(BUILD, sorted(BUILD), PREFIXES, REQUIRED, 500)
        self.assertEqual((stale, err), ([], None))

    def test_incomplete_build_deletes_nothing(self):
        stale, err = p.plan({"assets/demo.cast"}, ["assets/demo.cast", "assets/brand/og.png"], PREFIXES, REQUIRED, 500)
        self.assertEqual(stale, [])
        self.assertIn("missing", err)

    def test_empty_build_deletes_nothing(self):
        stale, err = p.plan(set(), ["assets/a", "css/b"], PREFIXES, REQUIRED, 500)
        self.assertEqual(stale, [])
        self.assertIsNotNone(err)

    def test_cap(self):
        keys = sorted(BUILD) + [f"assets/old-{i}.js" for i in range(11)]
        _, err = p.plan(BUILD, keys, PREFIXES, REQUIRED, 10)
        self.assertIn("more than --max-delete", err)

    def test_prefix_must_be_a_directory(self):
        for bad in ["assets", "/assets/", "/", ""]:
            _, err = p.plan(BUILD, [], [bad], REQUIRED, 10)
            self.assertIsNotNone(err, bad)


class Main(unittest.TestCase):
    """End to end against a stub aws that keeps a bucket in a JSON file."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = pathlib.Path(self.tmp.name)
        self.dist = root / "dist"
        for f in BUILD:
            (self.dist / f).parent.mkdir(parents=True, exist_ok=True)
            (self.dist / f).write_text("x")
        self.state = root / "bucket.json"
        self.state.write_text(json.dumps(sorted(BUILD) + ["assets/app-1.js", "js/main.js", "install.sh"]))
        bindir = root / "bin"
        bindir.mkdir()
        stub = bindir / "aws"
        stub.write_text(f"""#!{sys.executable}
import json, sys
state = {str(self.state)!r}
a = sys.argv[1:]
keys = json.load(open(state))
if a[:2] == ["s3api", "list-objects-v2"]:
    prefix = a[a.index("--prefix") + 1]
    hit = [k for k in keys if k.startswith(prefix)]
    print(json.dumps(hit) if hit else "null")
elif a[:2] == ["s3api", "delete-objects"]:
    gone = {{o["Key"] for o in json.loads(a[a.index("--delete") + 1])["Objects"]}}
    json.dump([k for k in keys if k not in gone], open(state, "w"))
    print("{{}}")
else:
    sys.exit("unexpected: " + " ".join(a))
""")
        stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
        self.old_path = os.environ["PATH"]
        os.environ["PATH"] = f"{bindir}{os.pathsep}{self.old_path}"
        self.addCleanup(lambda: os.environ.__setitem__("PATH", self.old_path))

    def args(self, *extra):
        a = ["--bucket", "b", "--dist", str(self.dist)]
        for x in PREFIXES:
            a += ["--prefix", x]
        for r in REQUIRED:
            a += ["--require", r]
        return a + list(extra)

    def test_prunes_and_leaves_unmanaged(self):
        self.assertEqual(p.main(self.args()), 0)
        left = json.loads(self.state.read_text())
        self.assertNotIn("assets/app-1.js", left)
        self.assertNotIn("js/main.js", left)
        self.assertIn("install.sh", left)
        self.assertTrue(BUILD <= set(left))

    def test_dry_run_deletes_nothing(self):
        before = self.state.read_text()
        self.assertEqual(p.main(self.args("--dry-run")), 0)
        self.assertEqual(self.state.read_text(), before)

    def test_cap_fails_without_deleting(self):
        before = self.state.read_text()
        self.assertEqual(p.main(self.args("--max-delete", "1")), 1)
        self.assertEqual(self.state.read_text(), before)


if __name__ == "__main__":
    unittest.main()
