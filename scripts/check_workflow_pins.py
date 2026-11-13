#!/usr/bin/env python3
"""Fail on a CI tool that runs unpinned or unverified (#707).

Checks every workflow under .github/workflows:

  1. `uses:` names a full 40-hex commit SHA (or a local ./ action).
  2. A container or service `image:` is pinned by @sha256 digest.
  3. Nothing installs `@latest` (go install, npm, npx, pip).
  4. Nothing pipes a download straight into tar, sh, bash, python or sudo.
  5. A step that downloads a release archive or binary (curl/wget of
     .tar.gz/.tgz/.zip/.deb/.rpm/.xz, or a releases/download/ URL) checks a
     pinned hash in the same step: `sha256sum -c` or `shasum -a 256 -c`.

A step can opt out of rule 5, and only rule 5, with a comment in its run
block, `# pin-check: unverified-ok -- <reason>`. The reason is required. It
exists for a job whose download IS the thing under test, such as
install-matrix.yml fetching spore.host's own latest release the way the docs
tell users to.

Line-based on purpose, so it needs no YAML library on the runner.

Usage:  python3 -I scripts/check_workflow_pins.py [workflow-dir]
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"

USES = re.compile(r"^\s*(?:-\s+)?uses:\s*([^\s#]+)")
IMAGE = re.compile(r"^\s*(?:-\s+)?image:\s*([^\s#]+)")
LATEST = re.compile(r"(go install|npm (?:i|install)|npx|pip3? install|uv pip install)\b[^#\n]*@latest\b")
PIPE_EXEC = re.compile(r"\b(curl|wget)\b[^#\n]*\|\s*(?:sudo\s+)?(tar|sh|bash|zsh|python3?|sudo)\b")
DOWNLOAD = re.compile(
    r"\b(curl|wget)\b[^#\n]*(\.tar\.gz|\.tgz|\.tar\.xz|\.zip|\.deb|\.rpm|\.xz|releases/download/|\$T\b|\$\{?T\}?\")"
)
VERIFY = re.compile(r"sha256sum\s+(-c|--check)|shasum\s+-a\s*256\s+(-c|--check)")
OPT_OUT = re.compile(r"#\s*pin-check:\s*unverified-ok\s+--\s+\S")
STEP_START = re.compile(r"^(\s*)-\s+(name|uses|run|id|if|with|env):")


def steps(lines):
    """Yield (first_line_number, [lines]) per step, approximately: a step
    starts at a `- name:`/`- uses:`/… list item and runs to the next one at
    the same or a shallower indent."""
    start, indent, buf = None, None, []
    for i, line in enumerate(lines, 1):
        m = STEP_START.match(line)
        if m and (indent is None or len(m.group(1)) <= indent):
            if buf:
                yield start, buf
            start, indent, buf = i, len(m.group(1)), [line]
        elif buf:
            buf.append(line)
    if buf:
        yield start, buf


def check_file(path):
    errs = []
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    rel = path.name
    for n, line in enumerate(lines, 1):
        code = line.split(" #", 1)[0] if not line.lstrip().startswith("#") else ""
        if not code.strip():
            continue
        m = USES.match(code)
        if m:
            ref = m.group(1)
            if not (ref.startswith("./") or re.search(r"@[0-9a-f]{40}$", ref) or re.search(r"^docker://.+@sha256:[0-9a-f]{64}$", ref)):
                errs.append(f"{rel}:{n}: uses {ref} is not pinned to a commit SHA")
        m = IMAGE.match(code)
        if m and not re.search(r"@sha256:[0-9a-f]{64}$", m.group(1)):
            errs.append(f"{rel}:{n}: image {m.group(1)} is not pinned by @sha256 digest")
        if LATEST.search(code):
            errs.append(f"{rel}:{n}: installs @latest")
        if PIPE_EXEC.search(code):
            errs.append(f"{rel}:{n}: pipes a download straight into an interpreter or tar")
    for start, block in steps(lines):
        body = "\n".join(block)
        code = "\n".join(l for l in block if not l.lstrip().startswith("#"))
        if DOWNLOAD.search(code) and not VERIFY.search(code) and not OPT_OUT.search(body):
            errs.append(f"{rel}:{start}: step downloads a release file without checking a pinned sha256")
    return errs


def main(argv):
    d = pathlib.Path(argv[1]) if len(argv) > 1 else WORKFLOWS
    files = sorted(list(d.glob("*.yml")) + list(d.glob("*.yaml")))
    if not files:
        print(f"::error::no workflows under {d}")
        return 1
    errs = [e for f in files for e in check_file(f)]
    for e in errs:
        print(f"::error::{e}")
    if errs:
        return 1
    print(f"{len(files)} workflows: every action, image and downloaded tool is pinned and verified")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
