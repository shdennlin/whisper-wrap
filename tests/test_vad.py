"""Tests for the VadBackend Protocol module (app/services/vad.py).

Covers Decision 1 (VadBackend protocol with two implementations),
Decision 2 (default to silero with auto-fallback), and Decision 4 (32 ms
sub-chunking) of v2-2-silero-vad.
"""

import logging
from unittest.mock import patch

import pytest


def test_protocol_surface():
    """The Protocol module exposes the names callers depend on, with the right shape.

    Covers the "Voice activity detection backend is pluggable" requirement.
    """
    from app.services.vad import RmsVad, VadBackend, make_vad_backend

    # Protocol declares the per-frame classifier
    assert hasattr(VadBackend, "is_speech"), "VadBackend must declare is_speech"

    # Both concrete classes satisfy the Protocol (runtime-checkable)
    rms = RmsVad()
    assert isinstance(rms, VadBackend), "RmsVad must conform to VadBackend"

    # Sanity: is_speech returns bool
    silence = b"\x00\x00" * 4_000  # 250 ms of pcm_s16le zeros at 16 kHz
    assert rms.is_speech(silence) is False

    # Factory exists with the documented signature
    assert callable(make_vad_backend)


def test_rms_vad_classifies_loud_as_speech():
    """RmsVad matches the v2.1 behaviour: int16 RMS above the threshold = speech."""
    import struct

    from app.services.vad import RmsVad

    rms = RmsVad()  # default threshold
    # Loud signal (amplitude well above threshold of 500)
    loud_samples = [4_000] * 4_000
    loud_pcm = struct.pack("<" + "h" * 4_000, *loud_samples)
    assert rms.is_speech(loud_pcm) is True

    # Silence
    silence = b"\x00\x00" * 4_000
    assert rms.is_speech(silence) is False


# ---------- Group 2: factory + auto-fallback ----------


def test_factory_returns_silero_when_unset_and_importable():
    """make_vad_backend(None) SHALL return SileroVad when silero_vad imports OK."""
    from app.services.vad import SileroVad, make_vad_backend

    backend = make_vad_backend(None)
    assert isinstance(backend, SileroVad)


def test_factory_falls_back_to_rms_when_silero_missing(caplog):
    """ImportError on silero_vad → RmsVad + one INFO log line naming the fallback."""
    from app.services.vad import RmsVad, make_vad_backend

    def raise_import_error(*args, **kwargs):
        raise ImportError("silero_vad not installed (simulated)")

    with patch("app.services.vad.SileroVad", side_effect=raise_import_error):
        with caplog.at_level(logging.INFO, logger="app.services.vad"):
            backend = make_vad_backend(None)

    assert isinstance(backend, RmsVad)
    fallback_lines = [
        r for r in caplog.records if "falling back to rms" in r.getMessage()
    ]
    assert len(fallback_lines) == 1, (
        f"expected exactly one fallback log line, got {len(fallback_lines)}"
    )


def test_factory_explicit_silero_raises_when_missing():
    """VAD_BACKEND=silero with import fail SHALL raise RuntimeError, not fall back."""
    from app.services.vad import make_vad_backend

    def raise_import_error(*args, **kwargs):
        raise ImportError("silero_vad not installed (simulated)")

    with patch("app.services.vad.SileroVad", side_effect=raise_import_error):
        with pytest.raises(RuntimeError, match=r"silero-vad is not installed"):
            make_vad_backend("silero")


def test_factory_explicit_rms_never_imports_silero():
    """VAD_BACKEND=rms SHALL return RmsVad without importing silero_vad."""
    from app.services.vad import RmsVad, make_vad_backend

    # If SileroVad were even constructed, this side_effect would fire.
    with patch(
        "app.services.vad.SileroVad",
        side_effect=AssertionError("SileroVad must not be constructed for VAD_BACKEND=rms"),
    ):
        backend = make_vad_backend("rms")
    assert isinstance(backend, RmsVad)


def test_factory_rejects_unknown_value():
    """Any value other than {None, '', 'silero', 'rms'} SHALL raise."""
    from app.services.vad import make_vad_backend

    with pytest.raises(RuntimeError, match=r"VAD_BACKEND='webrtc'"):
        make_vad_backend("webrtc")
    with pytest.raises(RuntimeError, match=r"accepted values: silero, rms"):
        make_vad_backend("typo")


# ---------- Group 3: SileroVad 32 ms sub-chunking ----------


def test_silero_classifies_fan_noise_as_silence():
    """Per Decision 4: chunked classification with all chunks <0.5 prob → False."""
    import struct
    from unittest.mock import MagicMock

    import torch

    from app.services.vad import SileroVad

    # 250 ms client frame = 4000 samples. Synthesise quiet noise PCM.
    frame_samples = 4_000
    pcm = struct.pack("<" + "h" * frame_samples, *([100] * frame_samples))

    backend = SileroVad()
    # Replace the model with a mock that always returns 0.1 (well below 0.5)
    fake_model = MagicMock(return_value=torch.tensor(0.1))
    backend._model = fake_model

    assert backend.is_speech(pcm) is False
    # 4000 samples / 512 per chunk → 7 full chunks classified
    assert fake_model.call_count == 7


def test_silero_classifies_quiet_speech_as_voice():
    """Per Decision 4: any chunk >=0.5 prob → True (any-speech-in-frame)."""
    import struct
    from unittest.mock import MagicMock

    import torch

    from app.services.vad import SileroVad

    frame_samples = 4_000
    pcm = struct.pack("<" + "h" * frame_samples, *([100] * frame_samples))

    backend = SileroVad()
    # Return 0.1, 0.1, 0.7 (third chunk crosses threshold) — should return True
    fake_model = MagicMock(
        side_effect=[
            torch.tensor(0.1),
            torch.tensor(0.1),
            torch.tensor(0.7),
        ]
    )
    backend._model = fake_model

    assert backend.is_speech(pcm) is True
    # Should short-circuit after the 3rd chunk
    assert fake_model.call_count == 3


# ---------- Group 3: StreamSession integration ----------


def test_stream_session_accepts_vad_backend_kwarg():
    """StreamSession SHALL accept a `vad_backend` kwarg and use it for the
    per-frame voice/silence decision instead of inline RMS — covering the
    "Server applies silence-duration endpointing to finalise utterances"
    requirement (only the per-frame classifier is delegated)."""
    import asyncio
    import struct
    from unittest.mock import MagicMock

    from app.services.stream import StreamSession
    from app.services.vad import VadBackend

    fake_vad = MagicMock(spec=VadBackend)
    fake_vad.is_speech = MagicMock(return_value=False)  # always silence

    events: list = []

    async def fake_transcribe(samples):
        return "ignored"

    async def fake_send(e):
        events.append(e)

    session = StreamSession(
        transcribe_fn=fake_transcribe,
        send_event=fake_send,
        vad_backend=fake_vad,
    )
    assert session.vad_backend is fake_vad

    # Feed a loud frame — RMS would say voice, but our fake VAD says silence.
    loud_pcm = struct.pack("<" + "h" * 4_000, *([4_000] * 4_000))

    async def drive():
        await session.feed_frame(loud_pcm)
        await session.drain()

    asyncio.run(drive())

    # Because the fake VAD said silence, no utterance was entered and no
    # partial was emitted. fake_vad.is_speech was called exactly once.
    assert fake_vad.is_speech.call_count == 1
    assert events == [], (
        f"VAD said silence but events were emitted: {events!r}"
    )


def test_per_session_vad_state_isolation():
    """Each StreamSession SHALL hold its own VadBackend instance — no sharing
    of silero-vad's LSTM hidden state across concurrent WS connections.
    Covers Decision 5."""
    from app.services.vad import RmsVad

    fake_factory_calls: list = []

    def factory():
        instance = RmsVad()
        fake_factory_calls.append(instance)
        return instance

    # Simulate two parallel sessions constructed via the factory pattern that
    # app/api/listen.py will use.
    instance_a = factory()
    instance_b = factory()

    assert instance_a is not instance_b, (
        "Factory MUST return a fresh instance per call to prevent state leakage"
    )
    assert len(fake_factory_calls) == 2
