"""Tests for `app/services/subtitle_format.py`.

Covers the SRT and WebVTT formatters used by the OpenAI-compat layer's
`response_format=srt` and `response_format=vtt` branches. The spec example
segments (openspec/specs/openai-compat/spec.md, scenarios `srt response returns
SRT subtitle text` and `vtt response returns WebVTT text`) anchor the
canonical-case tests; the remaining tests cover edge cases named in
tasks.md 1.1: zero-duration cues, sub-second timestamps, the one-hour
boundary.
"""

from app.services.subtitle_format import format_srt, format_vtt

SPEC_SEGMENTS = [(0.0, 2.5, "hello world."), (2.5, 6.0, " how are you.")]


def test_format_srt_spec_example():
    """SRT body matches the spec example exactly: comma ms separator, blank
    line between cues, trailing blank line."""
    assert format_srt(SPEC_SEGMENTS) == (
        "1\n"
        "00:00:00,000 --> 00:00:02,500\n"
        "hello world.\n"
        "\n"
        "2\n"
        "00:00:02,500 --> 00:00:06,000\n"
        " how are you.\n"
        "\n"
    )


def test_format_vtt_spec_example():
    """VTT body matches the spec example exactly: `WEBVTT` header + blank
    line, period ms separator, blank line between cues, trailing blank line."""
    assert format_vtt(SPEC_SEGMENTS) == (
        "WEBVTT\n"
        "\n"
        "00:00:00.000 --> 00:00:02.500\n"
        "hello world.\n"
        "\n"
        "00:00:02.500 --> 00:00:06.000\n"
        " how are you.\n"
        "\n"
    )


def test_format_srt_zero_duration_cue():
    """A cue with start == end is still emitted (timestamps unchanged)."""
    out = format_srt([(1.5, 1.5, "blip.")])
    assert "00:00:01,500 --> 00:00:01,500" in out
    assert "blip." in out


def test_format_vtt_zero_duration_cue():
    out = format_vtt([(1.5, 1.5, "blip.")])
    assert "00:00:01.500 --> 00:00:01.500" in out
    assert "blip." in out


def test_format_srt_sub_second_timestamps():
    """Sub-second timestamps round to nearest millisecond, no negative ms."""
    out = format_srt([(0.001, 0.999, "tick.")])
    assert "00:00:00,001 --> 00:00:00,999" in out


def test_format_vtt_sub_second_timestamps():
    out = format_vtt([(0.001, 0.999, "tick.")])
    assert "00:00:00.001 --> 00:00:00.999" in out


def test_format_srt_one_hour_boundary():
    """A cue that crosses the 3600s boundary uses HH=01, not 00."""
    out = format_srt([(3599.5, 3600.5, "tick.")])
    assert "00:59:59,500 --> 01:00:00,500" in out


def test_format_vtt_one_hour_boundary():
    out = format_vtt([(3599.5, 3600.5, "tick.")])
    assert "00:59:59.500 --> 01:00:00.500" in out


def test_format_srt_empty_segments_list():
    """Empty input → empty body (no header, no cues)."""
    assert format_srt([]) == ""


def test_format_vtt_empty_segments_list():
    """Empty input → still a valid WebVTT doc (header + trailing newline)."""
    assert format_vtt([]) == "WEBVTT\n\n"


def test_format_srt_cue_numbers_are_sequential():
    """Cue index starts at 1 and increments by 1."""
    segs = [(0.0, 1.0, "a"), (1.0, 2.0, "b"), (2.0, 3.0, "c")]
    out = format_srt(segs)
    assert out.startswith("1\n")
    assert "\n2\n00:00:01" in out
    assert "\n3\n00:00:02" in out
