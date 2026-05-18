"""Alembic upgrade head against a tempfile DB produces the expected schema."""

from __future__ import annotations

import pytest
from alembic.config import Config as AlembicConfig
from sqlalchemy import create_engine, inspect

from alembic import command


@pytest.fixture()
def alembic_cfg(tmp_path, monkeypatch):
    db_path = tmp_path / "wrap-test.db"
    url = f"sqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", url)
    cfg = AlembicConfig("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg, url


def test_alembic_upgrade_head_creates_expected_tables(alembic_cfg):
    cfg, url = alembic_cfg
    command.upgrade(cfg, "head")

    engine = create_engine(url)
    insp = inspect(engine)
    table_names = set(insp.get_table_names())
    assert {"sessions", "finals", "action_runs", "alembic_version"}.issubset(
        table_names
    )

    # Indexes from the initial schema should be present.
    sess_idx = {ix["name"] for ix in insp.get_indexes("sessions")}
    assert "idx_sessions_started" in sess_idx

    runs_idx = {ix["name"] for ix in insp.get_indexes("action_runs")}
    assert "idx_action_runs_session" in runs_idx
    assert "idx_action_runs_action" in runs_idx

    # `finals` has a composite PK (session_id, ord), no separate index needed.
    pk = insp.get_pk_constraint("finals")
    assert pk["constrained_columns"] == ["session_id", "ord"]

    engine.dispose()


def test_alembic_downgrade_round_trip(alembic_cfg):
    cfg, url = alembic_cfg
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "base")

    engine = create_engine(url)
    insp = inspect(engine)
    # Only `alembic_version` survives a base downgrade.
    assert set(insp.get_table_names()) == {"alembic_version"}
    engine.dispose()
