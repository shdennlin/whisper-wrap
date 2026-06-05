"""Initial schema: sessions, finals, action_runs

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-05-17 22:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial_schema"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("started_at", sa.Integer(), nullable=False),
        sa.Column("ended_at", sa.Integer(), nullable=True),
        sa.Column("mode", sa.String(length=8), nullable=False),
        sa.Column("audio_path", sa.Text(), nullable=True),
        sa.Column("audio_mime_type", sa.String(length=64), nullable=True),
        sa.Column("audio_size_bytes", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.CheckConstraint("mode IN ('batch','live')", name="ck_sessions_mode"),
    )
    op.create_index("idx_sessions_started", "sessions", ["started_at"])

    op.create_table(
        "finals",
        sa.Column("session_id", sa.String(length=36), nullable=False),
        sa.Column("ord", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("start_ms", sa.Integer(), nullable=True),
        sa.Column("end_ms", sa.Integer(), nullable=True),
        sa.Column("kind", sa.String(length=8), nullable=True),
        sa.ForeignKeyConstraint(
            ["session_id"], ["sessions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("session_id", "ord"),
    )

    op.create_table(
        "action_runs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("session_id", sa.String(length=36), nullable=False),
        sa.Column("action_id", sa.String(length=64), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("answer", sa.Text(), nullable=False),
        sa.Column("ran_at", sa.Integer(), nullable=False),
        sa.Column("model_used", sa.String(length=128), nullable=True),
        sa.Column("succeeded", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.ForeignKeyConstraint(
            ["session_id"], ["sessions.id"], ondelete="CASCADE"
        ),
    )
    op.create_index("idx_action_runs_session", "action_runs", ["session_id"])
    op.create_index("idx_action_runs_action", "action_runs", ["action_id"])


def downgrade() -> None:
    op.drop_index("idx_action_runs_action", table_name="action_runs")
    op.drop_index("idx_action_runs_session", table_name="action_runs")
    op.drop_table("action_runs")
    op.drop_table("finals")
    op.drop_index("idx_sessions_started", table_name="sessions")
    op.drop_table("sessions")
