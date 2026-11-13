#!/usr/bin/env python3
"""Every dependency manifest has a Dependabot entry, and every entry a manifest (#706).

.github/dependabot.yml pointed gomod at /spawn and /truffle, directories that
left with the CLIs' own repos, while the five Lambda modules, web/ and docs/
had no entry. Nothing noticed: Dependabot quietly updates nothing for a
directory it can't find a manifest in. This fails CI instead:

  - a tracked manifest (go.mod, package.json, pyproject.toml, Dockerfile)
    whose directory has no entry for its ecosystem;
  - an entry whose directory has no manifest for its ecosystem;
  - no github-actions entry for "/".

UNWATCHED lists manifests deliberately left out, each with its reason.

Line-based, so it needs no YAML library on the runner; it understands the
`package-ecosystem:` / `directory:` / `directories:` shapes dependabot.yml
uses.

Usage:  python3 -I scripts/check_dependabot_coverage.py [repo-root]
"""

import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

ECOSYSTEM_FOR = {
    "go.mod": "gomod",
    "package.json": "npm",
    "pyproject.toml": "pip",
    "Dockerfile": "docker",
}

# Manifests deliberately not watched, with why. Remove an entry when its
# reason stops being true.
UNWATCHED = {
    "sdk/python/pyproject.toml": (
        "stale copy of spore-host/python-sdk (extracted in 2d0c7ab; this copy is "
        "0.1.0, the repo 0.1.5) whose dependencies are Dependabot'd there; see #723"
    ),
}


def tracked_manifests(root):
    out = subprocess.run(["git", "-C", str(root), "ls-files"], check=True, capture_output=True, text=True).stdout
    found = {}
    for path in out.splitlines():
        name = path.rsplit("/", 1)[-1]
        if name in ECOSYSTEM_FOR and "/node_modules/" not in f"/{path}":
            found[path] = ECOSYSTEM_FOR[name]
    return found


def parse_config(text):
    """Return [(ecosystem, directory)] from dependabot.yml text."""
    entries, eco, in_dirs = [], None, False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        m = re.match(r"^\s*-\s+package-ecosystem:\s*[\"']?([\w-]+)", line)
        if m:
            eco, in_dirs = m.group(1), False
            continue
        m = re.match(r"^\s+directory:\s*[\"']?([^\"'\s]+)", line)
        if m and eco:
            entries.append((eco, m.group(1)))
            in_dirs = False
            continue
        if re.match(r"^\s+directories:\s*$", line):
            in_dirs = True
            continue
        m = re.match(r"^\s+-\s*[\"']?(/[^\"'\s]*)", line)
        if in_dirs and m and eco:
            entries.append((eco, m.group(1)))
            continue
        if in_dirs and re.match(r"^\s+\w[\w-]*:", line):
            in_dirs = False
    return entries


def norm(d):
    d = d.strip("/")
    return d if d else "."


def check(root, config_text, unwatched=None):
    unwatched = UNWATCHED if unwatched is None else unwatched
    manifests = tracked_manifests(root)
    entries = parse_config(config_text)
    errors = []
    configured = {(eco, norm(d)) for eco, d in entries}

    for path, eco in sorted(manifests.items()):
        if path in unwatched:
            continue
        d = norm(path.rsplit("/", 1)[0] if "/" in path else "")
        if (eco, d) not in configured:
            errors.append(f"{path}: no {eco} entry for /{d if d != '.' else ''} in .github/dependabot.yml")

    for eco, d in sorted(configured):
        if eco == "github-actions":
            continue
        prefix = "" if d == "." else d + "/"
        if not any(p.startswith(prefix) and p.count("/") == prefix.count("/") and e == eco for p, e in manifests.items()):
            errors.append(f"dependabot.yml: {eco} entry for /{d} but no {eco} manifest there")

    if ("github-actions", ".") not in configured:
        errors.append('dependabot.yml: no github-actions entry for "/"')

    for path in unwatched:
        if path not in manifests:
            errors.append(f"UNWATCHED lists {path}, which is no longer tracked; drop the exemption")
    return errors


def main(argv):
    root = pathlib.Path(argv[1]) if len(argv) > 1 else ROOT
    errors = check(root, (root / ".github" / "dependabot.yml").read_text())
    for e in errors:
        print(f"::error::{e}")
    if errors:
        return 1
    print("every dependency manifest has a Dependabot entry, and every entry a manifest")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
