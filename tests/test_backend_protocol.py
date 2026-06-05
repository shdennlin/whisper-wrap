"""Tests for the WhisperBackend Protocol surface (app/services/_whisper_backend.py).

Covers Decision 2: Abstract WhisperBackend Protocol up-front. The Protocol is the
durable contract every Whisper backend implementation must conform to.
"""

import inspect
from dataclasses import fields, is_dataclass


def test_protocol_surface():
    """The Protocol module exposes the names callers depend on, with the right shape.

    - `WhisperBackend`: Protocol declaring `transcribe` and `transcribe_pcm` (both async).
    - `WhisperLoadError`: raised by backend construction / model load.
    - `WhisperTranscriptionError`: raised during inference.
    - `WhisperBackendError`: common base so callers can catch any backend error.
    """
    from app.services._whisper_backend import (
        WhisperBackend,
        WhisperBackendError,
        WhisperLoadError,
        WhisperTranscriptionError,
    )

    # Common base
    assert issubclass(WhisperLoadError, WhisperBackendError), (
        "WhisperLoadError must inherit from WhisperBackendError"
    )
    assert issubclass(WhisperTranscriptionError, WhisperBackendError), (
        "WhisperTranscriptionError must inherit from WhisperBackendError"
    )

    # Protocol declares the two async methods
    assert hasattr(WhisperBackend, "transcribe"), (
        "WhisperBackend must declare transcribe"
    )
    assert hasattr(WhisperBackend, "transcribe_pcm"), (
        "WhisperBackend must declare transcribe_pcm"
    )

    # Both methods are coroutine functions on the Protocol
    assert inspect.iscoroutinefunction(WhisperBackend.transcribe), (
        "transcribe must be async"
    )
    assert inspect.iscoroutinefunction(WhisperBackend.transcribe_pcm), (
        "transcribe_pcm must be async"
    )


def test_transcription_result_shape():
    """TranscriptionResult and Segment are dataclasses with the declared fields."""
    from app.services._whisper_backend import Segment, TranscriptionResult

    assert is_dataclass(TranscriptionResult), "TranscriptionResult must be a dataclass"
    assert is_dataclass(Segment), "Segment must be a dataclass"

    tr_field_names = {f.name for f in fields(TranscriptionResult)}
    assert tr_field_names == {"text", "segments", "language", "duration_seconds"}, (
        f"TranscriptionResult fields wrong: {tr_field_names}"
    )

    seg_field_names = {f.name for f in fields(Segment)}
    assert seg_field_names == {"text", "start", "end"}, (
        f"Segment fields wrong: {seg_field_names}"
    )

    # Construction shape: minimal instance assembles cleanly
    seg = Segment(text="hello", start=0.0, end=1.0)
    result = TranscriptionResult(
        text="hello", segments=[seg], language="en", duration_seconds=1.0
    )
    assert result.text == "hello"
    assert result.segments[0].end == 1.0
