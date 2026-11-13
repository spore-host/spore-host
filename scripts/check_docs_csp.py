#!/usr/bin/env python3
"""Check a built docs site against the CSP docs.spore.host serves (#703).

The Content-Security-Policy is in infra/tofu/docs-site/csp.txt, which the
CloudFront response-headers policy reads. This script reads the same file and
fails if the build loads anything that policy would block:

  - a <script src>, stylesheet, font, image, iframe or CSS url()/@import from
    an origin its directive does not list;
  - an inline <script> without 'unsafe-inline' in script-src;
  - an inline event handler (onclick="...") at all: 'unsafe-inline' covers
    those too, but nothing in VitePress needs one, so a new one is a change
    worth looking at;
  - a .wasm file without 'wasm-unsafe-eval'.

It is static, so it can't see what a script fetches at run time. The
browser check in the PR that added it covers that once; this catches the
ordinary case, a page that starts loading something from somewhere new.

Usage:  python3 -I scripts/check_docs_csp.py [dist-dir] [csp-file]
"""

import pathlib
import re
import sys
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "docs" / ".vitepress" / "dist"
CSP = ROOT / "infra" / "tofu" / "docs-site" / "csp.txt"


def parse_csp(text):
    """Return {directive: [sources]} for a CSP header value."""
    out = {}
    for part in text.strip().split(";"):
        words = part.split()
        if words:
            out[words[0].lower()] = words[1:]
    return out


def sources_for(csp, directive):
    """The source list a fetch directive falls back to, per CSP3."""
    if directive in csp:
        return csp[directive]
    return csp.get("default-src", [])


def allowed(url, sources):
    """Whether url (absolute, protocol-relative, data: or same-origin) is allowed."""
    if url.startswith("data:"):
        return "data:" in sources
    if url.startswith("blob:"):
        return "blob:" in sources
    if url.startswith("//"):
        url = "https:" + url
    p = urlparse(url)
    if not p.scheme:  # relative: same origin
        return "'self'" in sources
    origin = f"{p.scheme}://{p.netloc}"
    for s in sources:
        if s == origin or s == p.scheme + ":":
            return True
        if s.startswith("https://*.") and p.scheme == "https" and p.netloc.endswith(s[len("https://*"):]):
            return True
    return False


TAG_RULES = [
    # (regex over HTML, directive)
    (re.compile(r"<script\b[^>]*\bsrc=[\"']([^\"']+)", re.I), "script-src"),
    (re.compile(r"<link\b(?=[^>]*\brel=[\"'][^\"']*stylesheet)[^>]*\bhref=[\"']([^\"']+)", re.I), "style-src"),
    (re.compile(r"<link\b(?=[^>]*\bas=[\"']script)[^>]*\bhref=[\"']([^\"']+)", re.I), "script-src"),
    (re.compile(r"<link\b(?=[^>]*\brel=[\"']modulepreload)[^>]*\bhref=[\"']([^\"']+)", re.I), "script-src"),
    (re.compile(r"<link\b(?=[^>]*\bas=[\"']font)[^>]*\bhref=[\"']([^\"']+)", re.I), "font-src"),
    (re.compile(r"<link\b(?=[^>]*\brel=[\"'][^\"']*icon)[^>]*\bhref=[\"']([^\"']+)", re.I), "img-src"),
    (re.compile(r"<link\b(?=[^>]*\brel=[\"']manifest)[^>]*\bhref=[\"']([^\"']+)", re.I), "manifest-src"),
    (re.compile(r"<img\b[^>]*\bsrc=[\"']([^\"']+)", re.I), "img-src"),
    (re.compile(r"<(?:iframe|frame)\b[^>]*\bsrc=[\"']([^\"']+)", re.I), "frame-src"),
    (re.compile(r"<(?:object|embed)\b[^>]*\b(?:data|src)=[\"']([^\"']+)", re.I), "object-src"),
]
INLINE_SCRIPT = re.compile(r"<script\b(?![^>]*\bsrc=)[^>]*>", re.I)
INLINE_HANDLER = re.compile(r"<[a-z][^>]*\son[a-z]+\s*=", re.I)
CSS_URL = re.compile(r"url\(\s*[\"']?([^\"')]+)", re.I)
CSS_IMPORT = re.compile(r"@import\s+(?:url\()?\s*[\"']([^\"']+)", re.I)


def check(dist, csp_text):
    csp = parse_csp(csp_text)
    errors = []
    script_src = sources_for(csp, "script-src")

    pages = sorted(dist.rglob("*.html"))
    if not pages:
        return [f"no HTML under {dist}: build the docs first"]
    for page in pages:
        rel = page.relative_to(dist)
        html = page.read_text(encoding="utf-8", errors="replace")
        for rx, directive in TAG_RULES:
            for url in rx.findall(html):
                if not allowed(url, sources_for(csp, directive)):
                    errors.append(f"{rel}: {directive} does not allow {url}")
        if INLINE_SCRIPT.search(html) and "'unsafe-inline'" not in script_src:
            errors.append(f"{rel}: inline <script> but script-src lacks 'unsafe-inline'")
        m = INLINE_HANDLER.search(html)
        if m:
            errors.append(f"{rel}: inline event handler {m.group(0)[:60]!r}")

    for css in sorted(dist.rglob("*.css")):
        rel = css.relative_to(dist)
        text = css.read_text(encoding="utf-8", errors="replace")
        for url in CSS_IMPORT.findall(text):
            if not allowed(url, sources_for(csp, "style-src")):
                errors.append(f"{rel}: style-src does not allow @import {url}")
        # url() inside an @import is a stylesheet, checked above, not an image.
        for url in CSS_URL.findall(re.sub(r"@import[^;]*;", "", text)):
            url = url.strip()
            directive = "font-src" if re.search(r"\.(woff2?|ttf|otf|eot)(\?|#|$)", url) else "img-src"
            if not allowed(url, sources_for(csp, directive)):
                errors.append(f"{rel}: {directive} does not allow url({url[:80]})")

    if any(dist.rglob("*.wasm")) and "'wasm-unsafe-eval'" not in script_src:
        errors.append("the build ships .wasm but script-src lacks 'wasm-unsafe-eval'")

    # Clickjacking protection must not be dropped by accident.
    if csp.get("frame-ancestors") != ["'none'"]:
        errors.append("frame-ancestors must be 'none'")
    return sorted(set(errors))


def main(argv):
    dist = pathlib.Path(argv[1]) if len(argv) > 1 else DIST
    csp_file = pathlib.Path(argv[2]) if len(argv) > 2 else CSP
    errors = check(dist, csp_file.read_text())
    for e in errors:
        print(f"::error::{e}")
    if errors:
        print(f"{len(errors)} CSP problem(s); fix the page or {csp_file.relative_to(ROOT) if csp_file.is_relative_to(ROOT) else csp_file}")
        return 1
    print(f"docs build is within the CSP in {csp_file.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
