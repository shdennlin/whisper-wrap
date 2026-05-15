"""WhisperBackend Protocol: the durable contract every Whisper backend conforms to.

Two concrete backends ship in v2.1:
  - `app.services.whisper_ct2.CTranslate2Backend` (Linux default, macOS fallback)
  - `app.services.whisper_cpp.PyWhisperCppBackend` (macOS default via Core ML/ANE)

Callers (`app/api/transcribe.py`, `app/api/ask.py`, `app/services/stream.py`)
depend on this Protocol surface alone — the concrete class is selected by the
FastAPI lifespan at startup and stored on `app.state.whisper`.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

import numpy as np


class WhisperBackendError(RuntimeError):
    """Base class for any backend-side error a caller may want to catch generically."""


class WhisperLoadError(WhisperBackendError):
    """Backend construction or model load failed (missing files, wrong platform, etc.)."""


class WhisperTranscriptionError(WhisperBackendError):
    """In-process transcription failed at runtime."""


@dataclass
class Segment:
    """One time-aligned segment of a transcript."""

    text: str
    start: float
    end: float


@dataclass
class TranscriptionResult:
    """Structured transcript returned by every backend's transcribe / transcribe_pcm."""

    text: str
    segments: list[Segment]
    language: str
    duration_seconds: float


@runtime_checkable
class WhisperBackend(Protocol):
    """The abstract surface every Whisper backend implementation must support.

    Implementations live alongside this file and are instantiated exactly once per
    process by the FastAPI lifespan. The Protocol does NOT prescribe constructor
    arguments — each implementation accepts its own backend-specific configuration
    and exposes the two async inference methods below.
    """

    async def transcribe(
        self,
        wav_path: Path,
        *,
        language: str,
        initial_prompt: str | None,
        task: str = "transcribe",
    ) -> TranscriptionResult:
        """Transcribe a WAV file at `wav_path`.

        `language="auto"` triggers backend-side language detection. `initial_prompt`
        is an optional bias string forwarded to the underlying model. `task` is
        `"transcribe"` (default) or `"translate"`; the latter routes through the
        underlying model's translation mode and the output language is English.

        Raises `WhisperTranscriptionError` on inference failure and the standard
        `FileNotFoundError` when `wav_path` does not exist.
        """
        ...

    async def transcribe_pcm(
        self,
        samples: np.ndarray,
        *,
        language: str,
    ) -> TranscriptionResult:
        """Transcribe a float32 mono 16 kHz PCM array.

        Used by `WS /listen`'s sliding-window inference loop; backends MAY take
        a shortcut for partial transcripts (e.g. skip post-processing) but the
        returned `TranscriptionResult` SHALL still carry text, segments,
        language, and duration_seconds.
        """
        ...
