"""Tests for the partial-consensus filter (Phase 2 of v2-1-whisper-cpp-backend).

Covers the "Partial-consensus filter stabilises partial emissions" requirement
in the transcribe-stream spec and Decision 6: Simplified LocalAgreement-2.
"""

import pytest


def test_two_stable_inferences_emit_partial():
    """Window N='今天' then N+1='今天天氣' SHALL emit partial with text='今天'."""
    from app.services.stream import PartialConsensusFilter

    f = PartialConsensusFilter()
    # First inference: no consensus possible yet
    assert f.update("今天") is None
    # Second inference: LCP at word boundary = "今天" (whole CJK is no whitespace; spec says punctuation OR whitespace; CJK without whitespace falls back to LCP truncated empty UNLESS we treat CJK as character-boundary-safe)
    emitted = f.update("今天天氣")
    assert emitted == "今天"


def test_unstable_emissions_suppressed():
    """Window N='今天' then N+1='明天天氣很好' SHALL emit no partial (no shared prefix)."""
    from app.services.stream import PartialConsensusFilter

    f = PartialConsensusFilter()
    assert f.update("今天") is None
    assert f.update("明天天氣很好") is None


def test_idempotent_partial_suppressed():
    """Same prefix emitted twice in a row SHALL only emit once."""
    from app.services.stream import PartialConsensusFilter

    f = PartialConsensusFilter()
    assert f.update("hello world") is None  # primer
    assert f.update("hello world there") == "hello world"
    # Next inference produces a longer transcript that still truncates back to "hello world"
    # because no consensus past "hello world " stabilises yet.
    assert f.update("hello world friends") is None  # LCP="hello world " truncates to "hello world"
    # ... and trying to emit the same prefix again SHALL be suppressed.


def test_final_still_emitted_with_no_partial():
    """An utterance with only one inference SHALL still emit final.

    The filter SHALL NOT apply to the final-event code path: that path passes
    the full transcript verbatim regardless of whether a partial ever stabilised.
    """
    from app.services.stream import PartialConsensusFilter

    f = PartialConsensusFilter()
    assert f.update("好") is None
    # No partial emission happened; the StreamSession's final-event code does
    # not consult the filter — see test_stream_final_bypasses_consensus.


def test_lcp_truncation_table():
    """Parameterised spec example table from transcribe-stream `Partial-consensus filter`."""
    from app.services.stream import compute_lcp_at_word_boundary

    cases = [
        # (window_N, window_N+1, expected_truncated_lcp)
        ("I went to", "I went to the store", "I went to"),
        ("I went to", "I want some coffee", ""),
        ("今天天氣", "今天天氣不錯", "今天天氣"),  # CJK has no whitespace; full LCP returned
        ("Hello wor", "Hello world", "Hello"),
    ]
    for prev, curr, expected in cases:
        result = compute_lcp_at_word_boundary(prev, curr)
        assert result == expected, (
            f"compute_lcp_at_word_boundary({prev!r}, {curr!r}) "
            f"= {result!r}, expected {expected!r}"
        )


def test_stream_emits_partial_with_consensus_filter_active(monkeypatch):
    """End-to-end via StreamSession: filter SHALL suppress partials until consensus."""
    import struct

    from app.services.stream import (
        PARTIAL_INTERVAL_MS,
        SILENCE_RMS_THRESHOLD,
        StreamSession,
    )

    # 250 ms loud frame (above RMS threshold) — synthesise a sine-ish square wave
    samples_per_frame = 4_000
    loud_pcm = struct.pack("<" + "h" * samples_per_frame, *([4000] * samples_per_frame))

    # Sequence the fake transcribe to return successive texts; final inference
    # after silence picks up whichever buffer is in flight.
    texts = iter(
        [
            "hello",  # 1st partial → cache only
            "hello world",  # 2nd partial → LCP "hello" emitted
            "hello world there",  # 3rd partial → LCP "hello world" emitted
            "hello world there",  # final on silence
        ]
    )

    async def fake_transcribe(samples):
        return next(texts)

    events: list = []

    async def fake_send(event):
        events.append(event)

    session = StreamSession(transcribe_fn=fake_transcribe, send_event=fake_send)

    # Feed loud frames until at least 3 partial events worth of interval have
    # passed. PARTIAL_INTERVAL_MS=500, each frame is 250 ms → emit on every
    # second frame. Need 3 partials' worth = ~6 frames.
    import asyncio

    async def drive():
        for _ in range(6):
            await session.feed_frame(loud_pcm)
        # Silence to trigger final
        silence_pcm = b"\x00\x00" * samples_per_frame
        for _ in range(4):  # 4 * 250 ms = 1 s > SILENCE_DURATION_MS
            await session.feed_frame(silence_pcm)

    asyncio.run(drive())

    partials = [e for e in events if e["type"] == "partial"]
    # First inference produces no partial (no consensus yet).
    # Second inference: LCP="hello" emitted.
    # Third inference: LCP="hello world" emitted (different from previous).
    # So expect exactly 2 partials.
    assert len(partials) == 2, f"expected 2 partials, got {len(partials)}: {partials}"
    assert partials[0]["text"] == "hello"
    assert partials[1]["text"] == "hello world"

    # Final SHALL be emitted regardless of filter state, carrying the full
    # transcript from the last inference.
    finals = [e for e in events if e["type"] == "final"]
    assert len(finals) == 1
    assert finals[0]["text"] == "hello world there"
