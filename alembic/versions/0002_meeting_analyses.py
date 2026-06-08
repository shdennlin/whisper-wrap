"""Meeting analyses history

Revision ID: 0002_meeting_analyses
Revises: 0001_initial_schema
Create Date: 2026-06-08 18:50:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002_meeting_analyses"
down_revision: Union[str, Sequence[str], None] = "0001_initial_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "meeting_analyses",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("language", sa.String(length=16), nullable=True),
        sa.Column("speakers_count", sa.Integer(), nullable=True),
        sa.Column("result_json", sa.Text(), nullable=False),
        sa.Column(
            "speaker_names_json",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'done'"),
        ),
    )
    op.create_index(
        "idx_meeting_analyses_created", "meeting_analyses", ["created_at"]
    )


def downgrade() -> None:
    op.drop_index("idx_meeting_analyses_created", table_name="meeting_analyses")
    op.drop_table("meeting_analyses")
