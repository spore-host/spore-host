#!/usr/bin/env python3
"""Delete stale objects from the spore.host site bucket, by manifest (#705).

`aws s3 sync --delete` ran only on the HTML pass, so every non-HTML file a
build ever uploaded stayed published: old portal bundles (assets/app-*.js,
app/assets/*), the legacy dashboard's js/, renamed images. This deletes
them, conservatively:

  - Only keys under the --prefix values (the directories the build owns
    outright) are candidates. Anything else in the bucket is never touched,
    however stale.
  - A candidate is deleted only if it is not in the manifest: the files of
    the build just uploaded (the --dist directory).
  - Nothing is deleted unless every --require file is in the manifest, so a
    broken or empty build can't turn into a mass delete.
  - Nothing is deleted if there are more than --max-delete candidates; the
    run fails instead, for a person to look at the list.
  - Run it after the upload, so every key the new HTML references is
    already in the bucket and in the manifest.

Usage:
  prune_site_bucket.py --bucket B --dist web/dist --prefix assets/ ... \
      --require index.html ... [--expected-owner ACCOUNT] [--max-delete N] [--dry-run]
"""

import argparse
import json
import os
import pathlib
import subprocess
import sys

BATCH = 1000  # DeleteObjects limit


def manifest(dist):
    """Every file under dist, as a bucket key."""
    root = pathlib.Path(dist)
    return {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}


def plan(files, keys, prefixes, required, max_delete):
    """Return (to_delete, error). error is None when to_delete may be deleted."""
    missing = [r for r in required if r not in files]
    if missing:
        return [], f"the build is missing {', '.join(missing)}; refusing to prune"
    for p in prefixes:
        if not p.endswith("/") or p.startswith("/") or p == "/":
            return [], f"prefix {p!r} must be a directory like 'assets/'"
    stale = sorted(k for k in keys if any(k.startswith(p) for p in prefixes) and k not in files)
    if len(stale) > max_delete:
        return stale, f"{len(stale)} stale objects is more than --max-delete {max_delete}; refusing to prune"
    return stale, None


def aws(*args):
    out = subprocess.run(["aws", *args], check=True, capture_output=True, text=True).stdout
    return json.loads(out) if out.strip() else None


def list_keys(bucket, prefix, owner):
    extra = ["--expected-bucket-owner", owner] if owner else []
    keys = aws("s3api", "list-objects-v2", "--bucket", bucket, "--prefix", prefix,
               "--query", "Contents[].Key", "--output", "json", *extra)
    return keys or []


def delete(bucket, keys, owner):
    extra = ["--expected-bucket-owner", owner] if owner else []
    for i in range(0, len(keys), BATCH):
        batch = {"Objects": [{"Key": k} for k in keys[i:i + BATCH]], "Quiet": True}
        out = aws("s3api", "delete-objects", "--bucket", bucket, "--delete", json.dumps(batch), *extra)
        errors = (out or {}).get("Errors") or []
        if errors:
            raise RuntimeError(f"delete-objects reported {len(errors)} error(s): {errors[:3]}")


def summary(lines):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--dist", required=True)
    ap.add_argument("--prefix", action="append", required=True)
    ap.add_argument("--require", action="append", default=[])
    ap.add_argument("--expected-owner", default="")
    ap.add_argument("--max-delete", type=int, default=500)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)

    files = manifest(a.dist)
    keys = [k for p in a.prefix for k in list_keys(a.bucket, p, a.expected_owner)]
    stale, err = plan(files, keys, a.prefix, a.require, a.max_delete)
    verb = "would delete" if a.dry_run else "deleting"
    lines = [f"### Site prune: {len(stale)} stale object(s) under {', '.join(a.prefix)}"]
    lines += [f"- `{k}`" for k in stale]
    print(f"{len(files)} files in the build, {len(keys)} objects under {' '.join(a.prefix)}; {verb} {len(stale)}")
    for k in stale:
        print(f"  {k}")
    if err:
        print(f"::error::{err}")
        summary(lines + [f"\n**Not pruned:** {err}"])
        return 1
    if a.dry_run or not stale:
        summary(lines + ([] if stale else ["Nothing to prune."]))
        return 0
    delete(a.bucket, stale, a.expected_owner)

    # Prove it: nothing outside the manifest is left under the managed prefixes.
    left = [k for p in a.prefix for k in list_keys(a.bucket, p, a.expected_owner) if k not in files]
    if left:
        print(f"::error::still present after prune: {left[:10]}")
        summary(lines + [f"\n**Still present after prune:** {len(left)}"])
        return 1
    summary(lines + ["\nDeleted; nothing outside the build remains under these prefixes."])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
