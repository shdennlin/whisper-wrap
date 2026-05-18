"""Pydantic v2 schemas for /v1/sessions endpoints.

`SessionDigest` excludes `finals` and `action_runs` to keep list responses
fast; `SessionFull` includes them inline for the detail endpoint.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

CaptureMode = Literal["batch", "live"]


class SessionCreate(BaseModel):
    """POST /v1/sessions body."""

    id: str = Field(min_length=1, max_length=36)
    started_at: int = Field(ge=0)
    mode: CaptureMode


class SessionPatch(BaseModel):
    """PATCH /v1/sessions/{id} body — partial update."""

    ended_at: int | None = None
    duration_ms: int | None = None
    audio_path: str | None = None
    audio_mime_type: str | None = None
    audio_size_bytes: int | None = None


class FinalIn(BaseModel):
    """POST /v1/sessions/{id}/finals body."""

    text: str
    start_ms: int | None = None
    end_ms: int | None = None
    kind: str | None = None


class FinalOut(BaseModel):
    """Serialised Final row."""

    model_config = ConfigDict(from_attributes=True)

    session_id: str
    ord: int
    text: str
    start_ms: int | None = None
    end_ms: int | None = None
    kind: str | None = None


class ActionRunIn(BaseModel):
    """POST /v1/sessions/{id}/runs body."""

    action_id: str
    prompt: str
    answer: str
    ran_at: int
    model_used: str | None = None
    succeeded: bool = True


class ActionRunOut(BaseModel):
    """Serialised ActionRun row."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    session_id: str
    action_id: str
    prompt: str
    answer: str
    ran_at: int
    model_used: str | None = None
    succeeded: bool


class SessionDigest(BaseModel):
    """Lean session row for list responses — no finals / runs inline."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    started_at: int
    ended_at: int | None = None
    mode: CaptureMode
    audio_path: str | None = None
    audio_mime_type: str | None = None
    audio_size_bytes: int | None = None
    duration_ms: int | None = None


class SessionFull(SessionDigest):
    """Detail response with eager-loaded children."""

    finals: list[FinalOut] = Field(default_factory=list)
    action_runs: list[ActionRunOut] = Field(default_factory=list)


class SessionListResponse(BaseModel):
    """GET /v1/sessions envelope.

    Returns SessionFull rows (with finals + action_runs eagerly loaded by the
    repo) so the PWA's list view can show text previews and char counts on
    the very first paint — historically this returned digest-only and the
    list rows were always empty until the user opened a detail panel.
    """

    sessions: list[SessionFull]
    next_before_ms: int | None = None


class AudioMetaOut(BaseModel):
    """Response body after POST /v1/sessions/{id}/audio."""

    audio_path: str
    audio_size_bytes: int
    audio_mime_type: str


class BulkAudioClearResponse(BaseModel):
    """Response body for DELETE /v1/sessions/audio."""

    deleted_count: int
