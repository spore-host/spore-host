#!/usr/bin/env python3
"""Tests for check_workflow_pins.py. Throwaway files only.

Usage:  python3 -I scripts/test_check_workflow_pins.py
"""

import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import check_workflow_pins as c  # noqa: E402

SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1"
DIGEST = "67518c174185a2043fdbed16c70631b79209499b3671178e7194379b48295a0d"

GOOD = f"""name: x
jobs:
  a:
    runs-on: ubuntu-latest
    container:
      image: semgrep/semgrep@sha256:{DIGEST} # 1.185.0
    steps:
      - uses: actions/checkout@{SHA} # v7
      - uses: ./.github/actions/local
      - name: Install tool
        run: |
          VER=1.0
          SHA256=abc
          T=tool.tar.gz
          curl -sSLf -o "$T" "https://github.com/o/r/releases/download/v$VER/$T"
          echo "$SHA256  $T" | sha256sum -c -
          tar -xzf "$T"
      - name: Pinned go tool
        run: go install golang.org/x/vuln/cmd/govulncheck@v1.3.0
      - name: Not a download
        run: curl -fsS "https://spore.host/" -o /dev/null
"""


class CheckWorkflowPins(unittest.TestCase):
    def errs(self, text):
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / "w.yml"
            p.write_text(text)
            return c.check_file(p)

    def test_good(self):
        self.assertEqual(self.errs(GOOD), [])

    def test_floating_image(self):
        self.assertTrue(self.errs(GOOD.replace(f"semgrep/semgrep@sha256:{DIGEST}", "semgrep/semgrep")))
        self.assertTrue(self.errs(GOOD.replace(f"semgrep/semgrep@sha256:{DIGEST}", "semgrep/semgrep:1.185.0")))

    def test_tag_pinned_action(self):
        self.assertTrue(self.errs(GOOD.replace(f"actions/checkout@{SHA}", "actions/checkout@v7")))

    def test_latest(self):
        self.assertTrue(self.errs(GOOD.replace("govulncheck@v1.3.0", "govulncheck@latest")))

    def test_curl_pipe_tar(self):
        bad = GOOD.replace('curl -sSLf -o "$T" "https://github.com/o/r/releases/download/v$VER/$T"',
                           'curl -sSL "https://github.com/o/r/releases/download/v$VER/$T" | tar -xz')
        self.assertTrue(any("pipes" in e for e in self.errs(bad)))

    def test_download_without_checksum(self):
        bad = GOOD.replace('echo "$SHA256  $T" | sha256sum -c -', "true")
        self.assertTrue(any("without checking" in e for e in self.errs(bad)))

    def test_checksum_only_in_a_comment_does_not_count(self):
        bad = GOOD.replace('echo "$SHA256  $T" | sha256sum -c -', "# sha256sum -c would go here")
        self.assertTrue(any("without checking" in e for e in self.errs(bad)))

    def test_opt_out_needs_a_reason(self):
        base = GOOD.replace('echo "$SHA256  $T" | sha256sum -c -', "true")
        ok = base.replace("VER=1.0", "# pin-check: unverified-ok -- the download is what this job tests\n          VER=1.0")
        self.assertEqual(self.errs(ok), [])
        no_reason = base.replace("VER=1.0", "# pin-check: unverified-ok\n          VER=1.0")
        self.assertTrue(self.errs(no_reason))

    def test_repo_workflows_pass(self):
        self.assertEqual(c.main(["x"]), 0)


if __name__ == "__main__":
    unittest.main()
