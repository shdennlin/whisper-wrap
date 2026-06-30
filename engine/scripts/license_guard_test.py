#!/usr/bin/env python3
"""Tests for the open-core engine license-metadata guard.

The engine guard (license-guard.sh) asserts core/server/cli carry the
GPL-3.0-or-later license metadata. These tests drive it with a fake `cargo`
on PATH so they need no real workspace build.
"""
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]  # -> engine/ (the public workspace)
SCRIPT = ROOT / "scripts" / "license-guard.sh"


def engine_metadata(
    core: str | None = "GPL-3.0-or-later",
    server: str | None = "GPL-3.0-or-later",
    cli: str | None = "GPL-3.0-or-later",
) -> dict:
    return {
        "packages": [
            {"id": "core", "name": "whisper-wrap-core", "license": core},
            {"id": "server", "name": "whisper-wrap-server", "license": server},
            {"id": "cli", "name": "whisper-wrap-cli", "license": cli},
        ],
        # The guard reads only `packages`; `cargo metadata --no-deps` sets
        # resolve to null, mirrored here.
        "resolve": None,
    }


class EngineLicenseGuardTests(unittest.TestCase):
    def run_guard_with_metadata(self, metadata: dict) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as td:
            fake_cargo = Path(td) / "cargo"
            fake_cargo.write_text(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                f"metadata = {json.dumps(metadata)!r}\n"
                "if sys.argv[1:2] == ['metadata']:\n"
                "    print(metadata)\n"
                "else:\n"
                "    sys.exit(2)\n",
                encoding="utf-8",
            )
            fake_cargo.chmod(fake_cargo.stat().st_mode | stat.S_IXUSR)
            env = os.environ.copy()
            env["PATH"] = f"{td}{os.pathsep}{env['PATH']}"
            return subprocess.run(
                ["bash", str(SCRIPT)],
                cwd=ROOT,
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )

    def test_accepts_open_core_crates_all_gplv3(self) -> None:
        result = self.run_guard_with_metadata(engine_metadata())

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("engine license-metadata intact", result.stdout)

    def test_rejects_non_gpl_open_core_crate(self) -> None:
        result = self.run_guard_with_metadata(engine_metadata(server="MIT"))

        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("VIOLATED", result.stdout)
        self.assertIn("whisper-wrap-server", result.stdout)


if __name__ == "__main__":
    unittest.main()
