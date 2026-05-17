"""Test-suite-wide fixtures.

Persistence isolation: every test gets a fresh tempdir for data and a unique
SQLite file. Without this, tests would otherwise hit the dev's `./data/`
directory and stomp real history. Auto-applied via `autouse=True` so even
the lifespan tests under test_main.py don't need to opt in.
"""

from __future__ import annotations

import os

import pytest


@pytest.fixture(autouse=True)
def _isolate_persistence(tmp_path, monkeypatch):
    """Point persistence at a per-test tempdir; reset config + SessionLocal."""
    data_dir = tmp_path / "wrap-data"
    monkeypatch.setenv("DATA_DIR", str(data_dir))
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{data_dir}/history.db")

    # The module-level `config` singleton was constructed at import time, so
    # patch its attributes directly. Tests that build their own Config will
    # still see the env vars.
    from pathlib import Path

    from app.config import config as app_cfg

    monkeypatch.setattr(app_cfg, "DATA_DIR", Path(str(data_dir)))
    monkeypatch.setattr(
        app_cfg, "DATABASE_URL", f"sqlite:///{data_dir}/history.db"
    )

    yield

    # SessionLocal may have been bound to a previous test's engine; clear it
    # so the next lifespan rebinds cleanly.
    from app.services.persistence import SessionLocal

    SessionLocal.configure(bind=None)
