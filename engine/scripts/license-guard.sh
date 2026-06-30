#!/usr/bin/env bash
# Engine license-metadata guard (open-core).
#
# The open-core engine crates (core, server, cli) are distributed under GPLv3.
# This guard asserts their Cargo license metadata still says so — if a crate
# silently loses or changes its `license` (e.g. an accidental edit or a bad
# workspace-inherit), the open-core boundary is broken and the build must fail.
#
# This is the engine half of the split license guard: the umbrella keeps the
# desktop half (no-engine-link + proprietary + dependency-license checks). The
# umbrella Makefile's `license-guard` target invokes BOTH.
# Fail closed: if `cargo metadata` can't run, the boundary is unverifiable.
set -euo pipefail

cd "$(dirname "$0")/.." # -> engine/ (the public cargo workspace)

meta_file=$(mktemp)
trap 'rm -f "$meta_file"' EXIT
cargo metadata --format-version 1 --no-deps >"$meta_file" 2>/dev/null || {
  echo "✗ cannot run 'cargo metadata' — engine license-metadata boundary unverifiable"
  exit 1
}

python3 - "$meta_file" <<'PY'
import json, sys

WANT = {
    "whisper-wrap-core": "GPL-3.0-or-later",
    "whisper-wrap-server": "GPL-3.0-or-later",
    "whisper-wrap-cli": "GPL-3.0-or-later",
}
meta = json.load(open(sys.argv[1]))
got = {p["name"]: p.get("license") for p in meta["packages"]}

bad = [(n, exp, got.get(n)) for n, exp in WANT.items() if got.get(n) != exp]
if bad:
    print("✗ engine license-metadata boundary VIOLATED:")
    for n, exp, g in bad:
        print(f"    {n}: expected {exp}, got {g}")
    sys.exit(1)
print("✓ engine license-metadata intact: core/server/cli GPLv3")
PY
