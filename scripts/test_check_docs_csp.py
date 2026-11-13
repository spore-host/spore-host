#!/usr/bin/env python3
"""Tests for check_docs_csp.py. No network; throwaway directories only.

Usage:  python3 -I scripts/test_check_docs_csp.py
"""

import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import check_docs_csp as c  # noqa: E402

CSP = (pathlib.Path(__file__).resolve().parent.parent / "infra" / "tofu" / "docs-site" / "csp.txt").read_text()

OK_PAGE = """<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">
<link rel="icon" href="/favicon.svg">
<link rel="modulepreload" href="/assets/chunks/framework.js">
<script>(()=>{const e=localStorage.getItem("x")})()</script>
<script type="module" src="/assets/app.js"></script>
</head><body><img src="/logo.png" style="width:1px"></body></html>"""


class CheckDocsCSP(unittest.TestCase):
    def build(self, files):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        root = pathlib.Path(d.name)
        for name, body in files.items():
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(body)
        return root

    def test_vitepress_shape_passes(self):
        css = 'a{mask:url("data:image/svg+xml,%3Csvg%3E")} @font-face{src:url(/assets/f.woff2)}'
        self.assertEqual(c.check(self.build({"index.html": OK_PAGE, "vp-icons.css": css}), CSP), [])

    def test_new_script_origin_fails(self):
        page = OK_PAGE.replace("</head>", '<script src="https://cdn.example.com/x.js"></script></head>')
        errs = c.check(self.build({"index.html": page}), CSP)
        self.assertTrue(any("cdn.example.com" in e for e in errs), errs)

    def test_external_image_fails(self):
        page = OK_PAGE.replace("/logo.png", "https://img.shields.io/badge.svg")
        self.assertTrue(c.check(self.build({"index.html": page}), CSP))

    def test_iframe_fails(self):
        page = OK_PAGE.replace("<body>", '<body><iframe src="https://www.youtube.com/embed/x"></iframe>')
        self.assertTrue(c.check(self.build({"index.html": page}), CSP))

    def test_inline_handler_fails(self):
        page = OK_PAGE.replace("<body>", '<body onload="x()">')
        self.assertTrue(c.check(self.build({"index.html": page}), CSP))

    def test_wasm_needs_wasm_unsafe_eval(self):
        errs = c.check(self.build({"index.html": OK_PAGE, "assets/r.wasm": ""}), CSP)
        self.assertTrue(any("wasm" in e for e in errs), errs)

    def test_css_import_and_font(self):
        css = '@import url("https://evil.example/x.css"); @font-face{src:url(https://cdn.example/f.woff2)}'
        errs = c.check(self.build({"index.html": OK_PAGE, "a.css": css}), CSP)
        self.assertEqual(len(errs), 2, errs)

    def test_inline_script_needs_unsafe_inline(self):
        strict = CSP.replace("script-src 'self' 'unsafe-inline'", "script-src 'self'")
        errs = c.check(self.build({"index.html": OK_PAGE}), strict)
        self.assertTrue(any("inline <script>" in e for e in errs), errs)

    def test_frame_ancestors_required(self):
        loose = CSP.replace("frame-ancestors 'none'", "frame-ancestors *")
        self.assertTrue(c.check(self.build({"index.html": OK_PAGE}), loose))

    def test_empty_build_fails(self):
        self.assertTrue(c.check(self.build({}), CSP))

    def test_policy_parses(self):
        p = c.parse_csp(CSP)
        self.assertEqual(p["default-src"], ["'self'"])
        self.assertNotIn("'unsafe-eval'", p["script-src"])


if __name__ == "__main__":
    unittest.main()
