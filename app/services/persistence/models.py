"""Declarative SQLAlchemy 2.0 table definitions.

Three tables form a minimal capture-history schema:

- `sessions`: per-recording metadata (mode, lifecycle timestamps, optional
  audio file pointer). UUID-string primary key — generated client-side so
  the PWA can write to local cache before the round-trip resolves.
- `finals`: append-only transcript segments per session. Composite PK
  `(session_id, ord)` keeps insertion order without an extra `ROWID`.
- `action_runs`: one row per AI chip invocation (action_id + prompt +
  answer + model used). Autoincrementing PK because runs can be ordered
  by `ran_at` but identity-by-time isn't unique under fast taps.

Cascade semantics: deleting a session removes its finals and action_runs
via FK `ondelete="CASCADE"` so the API delete handler doesn't need to
sequence three DELETEs.
"""

from __future__ import annotations

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    mapped_column,
    relationship,
)


class Base(DeclarativeBase):
    """Common declarative base — all tables share `Base.metadata`."""


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    started_at: Mapped[int] = mapped_column(Integer, nullable=False)
    ended_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    mode: Mapped[str] = mapped_column(String(8), nullable=False)
    audio_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    audio_mime_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    audio_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    finals: Mapped[list["Final"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="Final.ord",
        passive_deletes=True,
    )
    action_runs: Mapped[list["ActionRun"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="ActionRun.ran_at",
        passive_deletes=True,
    )

    __table_args__ = (
        CheckConstraint("mode IN ('batch','live')", name="ck_sessions_mode"),
        Index("idx_sessions_started", "started_at"),
    )


class Final(Base):
    __tablename__ = "finals"

    session_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    ord: Mapped[int] = mapped_column(Integer, primary_key=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    start_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    end_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    kind: Mapped[str | None] = mapped_column(String(8), nullable=True)

    session: Mapped["Session"] = relationship(back_populates="finals")


class ActionRun(Base):
    __tablename__ = "action_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    action_id: Mapped[str] = mapped_column(String(64), nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    answer: Mapped[str] = mapped_column(Text, nullable=False)
    ran_at: Mapped[int] = mapped_column(Integer, nullable=False)
    model_used: Mapped[str | None] = mapped_column(String(128), nullable=True)
    succeeded: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    session: Mapped["Session"] = relationship(back_populates="action_runs")

    __table_args__ = (
        Index("idx_action_runs_session", "session_id"),
        Index("idx_action_runs_action", "action_id"),
    )
