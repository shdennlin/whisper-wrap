"""Pydantic v2 schemas for /v1/meetings endpoints.

The meeting history endpoint persists what `/transcribe/meeting`
produces so the PWA sidebar survives JobStore TTL eviction and
restarts. Shapes mirror `app/api/schemas/sessions.py` patterns.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

_ID_PATTERN = r"^[A-Za-z0-9_-]{1,36}$"


class MeetingCreate(BaseModel):
    r"""POST /v1/meetings body — supplies the full payload.

    Used by:
      - the worker's auto-persist path inside `_run_meeting_job` (so
        the row lands without a client roundtrip)
      - the PWA migration from localStorage on first load

    `id` regex is intentionally restrictive — only alphanumerics, `_`,
    and `-`. This blocks `..`, `/`, `\`, NUL, spaces, etc. so the id
    is safe to interpolate into filesystem paths in
    `upload_meeting_audio`. ULID-style and UUID job_ids both fit.
    """

    id: str = Field(min_length=1, max_length=36, pattern=_ID_PATTERN)
    filename: str
    result: dict[str, Any]
    created_at: int | None = Field(default=None, ge=0)
    duration_seconds: float | None = None
    language: str | None = None
    speakers_count: int | None = Field(default=None, ge=0)
    speaker_names: dict[str, str] = Field(default_factory=dict)
    status: str = "done"


class MeetingPatch(BaseModel):
    """PATCH /v1/meetings/{id} — only `speaker_names` is mutable.

    Result content + metadata are write-once. Renames are the only
    post-write user input on a finished analysis.
    """

    speaker_names: dict[str, str]


class MeetingFull(BaseModel):
    """Detail / list-row response shape."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    created_at: int
    filename: str
    duration_seconds: float | None = None
    language: str | None = None
    speakers_count: int | None = None
    result: dict[str, Any]
    speaker_names: dict[str, str] = Field(default_factory=dict)
    status: str
    # Audio metadata — null until the client uploads via POST
    # /v1/meetings/{id}/audio. `audio_path` is the server-side disk
    # path (not exposed for fetch — the client uses GET
    # /v1/meetings/{id}/audio); included so the PWA can tell whether
    # to render an audio player or "audio not stored" hint.
    audio_path: str | None = None
    audio_mime_type: str | None = None
    audio_size_bytes: int | None = None


class MeetingAudioMetaOut(BaseModel):
    """Response body after POST /v1/meetings/{id}/audio."""

    audio_path: str
    audio_mime_type: str
    audio_size_bytes: int


class MeetingListResponse(BaseModel):
    """GET /v1/meetings envelope. Cursor pagination via `before_ms`."""

    meetings: list[MeetingFull]
    next_before_ms: int | None = None
