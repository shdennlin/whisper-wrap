"""Meeting analyses: audio file pointer columns

Revision ID: 0003_meeting_analyses_audio
Revises: 0002_meeting_analyses
Create Date: 2026-06-08 20:10:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_meeting_analyses_audio"
down_revision: Union[str, Sequence[str], None] = "0002_meeting_analyses"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("meeting_analyses") as batch_op:
        batch_op.add_column(sa.Column("audio_path", sa.Text(), nullable=True))
        batch_op.add_column(
            sa.Column("audio_mime_type", sa.String(length=64), nullable=True)
        )
        batch_op.add_column(
            sa.Column("audio_size_bytes", sa.Integer(), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("meeting_analyses") as batch_op:
        batch_op.drop_column("audio_size_bytes")
        batch_op.drop_column("audio_mime_type")
        batch_op.drop_column("audio_path")
