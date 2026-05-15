"""Tests for the streaming wrapper and WS /listen (tasks 5.1-5.5)."""

import json
import math
import struct
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.services.stream import (
    SAMPLE_RATE,
    StreamSession,
    compute_rms,
    frame_duration_ms,
)

# ===========================================================================
# Helpers
# ===========================================================================


def silence_frame(ms: int = 250) -> bytes:
    n = (SAMPLE_RATE * ms) // 1000
    return struct.pack(f"<{n}h", *([0] * n))


def voice_frame(ms: int = 250, amplitude: int = 10_000) -> bytes:
    """A loud 440 Hz sinusoid that crosses the RMS-energy VAD threshold."""
    n = (SAMPLE_RATE * ms) // 1000
    samples = [
        int(amplitude * math.sin(2 * math.pi * 440 * i / SAMPLE_RATE))
        for i in range(n)
    ]
    return struct.pack(f"<{n}h", *samples)


@pytest.fixture
def captured_session():
    """Return (session, events_list, transcribe_calls) tied together."""
    events: list[dict] = []
    transcribe_calls: list[int] = []

    async def send_event(e):
        events.append(e)

    async def transcribe_fn(samples):
        transcribe_calls.append(len(samples))
        return f"len={len(samples)}"

    session = StreamSession(transcribe_fn=transcribe_fn, send_event=send_event)
    return session, events, transcribe_calls


# ===========================================================================
# Task 5.1: PCM ingestion + sliding-window transcription
# ===========================================================================


async def test_voice_frames_trigger_transcription(captured_session):
    session, events, transcribe_calls = captured_session
    # 4 × 250 ms voice = 1 s of speech (one partial fires at audio_ms=750)
    for _ in range(4):
        await session.feed_frame(voice_frame(250))
    assert len(transcribe_calls) >= 1, "Expected at least one transcription call"


async def test_silence_only_does_not_transcribe(captured_session):
    session, events, transcribe_calls = captured_session
    for _ in range(4):
        await session.feed_frame(silence_frame(250))
    assert transcribe_calls == [], "Silence SHALL NOT trigger transcription"
    assert events == [], "Silence SHALL NOT emit any events"


# ===========================================================================
# Task 5.2: partial + final events with timestamped audio time
# ===========================================================================


async def test_voice_then_silence_emits_partial_then_final(captured_session):
    """1 s of voice followed by 1 s of silence → partials during voice + a final at endpoint."""
    session, events, _ = captured_session
    for _ in range(4):
        await session.feed_frame(voice_frame(250))
    for _ in range(4):
        await session.feed_frame(silence_frame(250))

    types = [e["type"] for e in events]
    assert "partial" in types
    assert "final" in types

    # Final event SHALL carry start_ms and end_ms in audio time.
    final = next(e for e in events if e["type"] == "final")
    assert final["start_ms"] >= 0
    assert final["end_ms"] >= final["start_ms"]
    assert "text" in final


async def test_partial_event_shape_matches_spec(captured_session):
    """v2.1: consensus filter suppresses the first inference, so we need ≥2
    inferences to see a partial. 6 voice frames (1.5 s) trigger 2 inferences."""
    session, events, _ = captured_session
    for _ in range(6):
        await session.feed_frame(voice_frame(250))
    partials = [e for e in events if e["type"] == "partial"]
    assert partials, "Expected at least one partial event"
    p = partials[0]
    assert set(p.keys()) == {"type", "text", "start_ms", "end_ms"}
    assert isinstance(p["start_ms"], int)
    assert isinstance(p["end_ms"], int)
    assert p["end_ms"] >= p["start_ms"]


async def test_multiple_utterances_per_connection_monotonic_timestamps(captured_session):
    """Two utterances separated by silence SHALL produce two finals with monotonic ts."""
    session, events, _ = captured_session
    # Utterance 1
    for _ in range(4):
        await session.feed_frame(voice_frame(250))
    for _ in range(4):
        await session.feed_frame(silence_frame(250))
    # Utterance 2
    for _ in range(4):
        await session.feed_frame(voice_frame(250))
    for _ in range(4):
        await session.feed_frame(silence_frame(250))

    finals = [e for e in events if e["type"] == "final"]
    assert len(finals) == 2, f"Expected 2 finals, got {len(finals)}: {events}"
    assert finals[0]["end_ms"] < finals[1]["start_ms"], "Timestamps not monotonic"
    assert finals[1]["start_ms"] > 0


# ===========================================================================
# Task 5.3: disconnect mid-utterance discards in-flight buffer
# ===========================================================================


async def test_no_final_emitted_when_only_partial_voice(captured_session):
    """Stream voice WITHOUT trailing silence → no final event from feed_frame alone.

    (The WS handler discards the in-flight buffer on disconnect; no explicit final.)
    """
    session, events, _ = captured_session
    for _ in range(2):
        await session.feed_frame(voice_frame(250))
    types = [e["type"] for e in events]
    assert "final" not in types


async def test_completed_utterance_then_disconnect_keeps_earlier_final(captured_session):
    """A final from utterance A SHALL stand even if the session ends without further input."""
    session, events, _ = captured_session
    # Complete utterance A
    for _ in range(4):
        await session.feed_frame(voice_frame(250))
    for _ in range(4):
        await session.feed_frame(silence_frame(250))
    finals_before = [e for e in events if e["type"] == "final"]
    assert len(finals_before) == 1
    # No more frames; no further events should appear.
    finals_after = [e for e in events if e["type"] == "final"]
    assert finals_after == finals_before


# ===========================================================================
# Task 5.5: backpressure / 30-second buffer cap
# ===========================================================================


async def test_buffer_overflow_emits_one_warning(captured_session, monkeypatch):
    """Lower MAX_BUFFER_BYTES so we overflow cheaply; assert one warning fires."""
    # Cap to ~250 ms worth of audio (8000 bytes) so the next frame overflows.
    monkeypatch.setattr("app.services.stream.MAX_BUFFER_BYTES", 8_000)

    session, events, _ = captured_session
    # Pump 8 voice frames; the buffer will repeatedly trim to keep within cap.
    for _ in range(8):
        await session.feed_frame(voice_frame(250))

    warnings = [e for e in events if e["type"] == "warning"]
    assert len(warnings) >= 1
    assert "buffer overflow" in warnings[0]["message"]


# ===========================================================================
# Pure-function tests
# ===========================================================================


def test_compute_rms_zero_for_silence():
    assert compute_rms(silence_frame()) == 0.0


def test_compute_rms_above_threshold_for_voice():
    # amplitude=10000 sine → RMS ≈ 7071
    rms = compute_rms(voice_frame())
    assert rms > 5_000


def test_frame_duration_ms_matches_audio_duration():
    assert frame_duration_ms(voice_frame(250)) == 250
    assert frame_duration_ms(silence_frame(100)) == 100


# ===========================================================================
# Task 5.4: WebSocket frame-size guards (protocol layer)
# ===========================================================================


@pytest.fixture
def ws_client(monkeypatch):
    """TestClient with WhisperClient.transcribe_pcm stubbed; used for protocol tests."""
    monkeypatch.setattr(
        "app.main._build_backend",
        lambda **kw: (MagicMock(name="WhisperBackend"), {
            "backend": "ctranslate2", "format": "ct2",
            "compute_type": "default", "local_dir": "/fake",
        }),
    )

    async def fake(samples, **kw):
        return "stub"

    from app.main import app

    with TestClient(app) as c:
        app.state.whisper.transcribe_pcm = fake
        yield c


def test_non_binary_text_frame_rejected_with_close(ws_client):
    with ws_client.websocket_connect("/listen") as ws:
        ws.send_text("not binary")
        msg = ws.receive_text()
        body = json.loads(msg)
        assert body == {"type": "error", "message": "binary PCM expected"}
        # Subsequent receive raises (socket closed).
        with pytest.raises(Exception):  # noqa: B017
            ws.receive_text()


def test_undersized_binary_frame_rejected_with_close(ws_client):
    with ws_client.websocket_connect("/listen") as ws:
        ws.send_bytes(b"\x00" * 100)  # < 200 bytes
        msg = ws.receive_text()
        body = json.loads(msg)
        assert body == {"type": "error", "message": "frame size out of range"}


def test_oversized_binary_frame_rejected_with_close(ws_client):
    with ws_client.websocket_connect("/listen") as ws:
        ws.send_bytes(b"\x00" * (65_536 + 1))
        msg = ws.receive_text()
        body = json.loads(msg)
        assert body == {"type": "error", "message": "frame size out of range"}


def test_valid_silence_frame_accepted(ws_client):
    """A well-sized silence frame SHALL not trigger an error close — session continues."""
    with ws_client.websocket_connect("/listen") as ws:
        ws.send_bytes(silence_frame(250))
        # No error event expected. Close the socket cleanly.
        # (We rely on no events arriving; can't easily prove a negative within timeout
        #  in TestClient, but if the server had errored it would have closed and the
        #  next operation would raise.)
        ws.close()
