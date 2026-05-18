"""Tests for app.services.postprocess (transcription empty-filter)."""

import pytest

from app.services.postprocess import (
    Drop,
    Keep,
    filter_empty_transcription,
)


@pytest.mark.parametrize(
    "text,duration_ms",
    [
        ("", None),
        ("hello", 200),
        ("。", 100),
        ("", 5000),
    ],
)
def test_enabled_false_always_keeps(text, duration_ms):
    """When `enabled=False` the filter SHALL be a no-op regardless of content."""
    decision = filter_empty_transcription(
        text=text,
        duration_ms=duration_ms,
        enabled=False,
        min_duration_ms=500,
    )
    assert decision == Keep(text)


def test_sub_duration_drop():
    decision = filter_empty_transcription(
        text="anything",
        duration_ms=320,
        enabled=True,
        min_duration_ms=500,
    )
    assert decision == Drop("below_min_duration")


def test_equal_duration_keeps():
    """duration_ms == min_duration_ms is the boundary — SHALL Keep."""
    decision = filter_empty_transcription(
        text="hi",
        duration_ms=500,
        enabled=True,
        min_duration_ms=500,
    )
    assert decision == Keep("hi")


def test_duration_none_skips_duration_check():
    """`/transcribe` passes duration_ms=None — only the empty-text check applies."""
    decision = filter_empty_transcription(
        text="hello",
        duration_ms=None,
        enabled=True,
        min_duration_ms=500,
    )
    assert decision == Keep("hello")


@pytest.mark.parametrize(
    "empty_text",
    [
        "",
        "   ",
        "\t\n  ",
        ".",
        ".,!",
        "...",
        "。",
        "，",
        "、",
        "；",
        "：",
        "？",
        "！",
        "「",
        "」",
        "『",
        "』",
        "（",
        "）",
        "《",
        "》",
        "〈",
        "〉",
        "…",
        "—",
        "·",
        "。。。",
        "， 。",
        " 。 ， ",
    ],
)
def test_empty_text_drop(empty_text):
    decision = filter_empty_transcription(
        text=empty_text,
        duration_ms=None,
        enabled=True,
        min_duration_ms=500,
    )
    assert decision == Drop("empty_text")


@pytest.mark.parametrize(
    "valid_text",
    [
        "好",
        "對",
        "是",
        "Hi.",
        "hello",
        "今天天氣很好",
        "a",
        "1",
        "好。",
        "Hi!",
    ],
)
def test_valid_content_kept(valid_text):
    decision = filter_empty_transcription(
        text=valid_text,
        duration_ms=None,
        enabled=True,
        min_duration_ms=500,
    )
    assert decision == Keep(valid_text)


def test_negative_min_duration_raises():
    with pytest.raises(ValueError, match="min_duration_ms"):
        filter_empty_transcription(
            text="hello",
            duration_ms=None,
            enabled=True,
            min_duration_ms=-1,
        )


def test_keep_preserves_original_text():
    """Keep wraps the ORIGINAL text untouched (no stripping)."""
    decision = filter_empty_transcription(
        text="  hello  ",
        duration_ms=None,
        enabled=True,
        min_duration_ms=500,
    )
    assert decision == Keep("  hello  ")
