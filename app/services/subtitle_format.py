"""SRT and WebVTT formatters for the OpenAI-compat layer.

Used by `app/api/openai_compat.py` when `response_format=srt` or
`response_format=vtt` is requested. Segment input is a list of
`(start_s: float, end_s: float, text: str)` tuples in the order the
underlying Whisper backend produced them.

The SRT body uses a comma as the millisecond separator (SRT convention).
The WebVTT body uses a period (WebVTT convention), preceded by the literal
`WEBVTT` header line and a blank line.
"""

from __future__ import annotations

from collections.abc import Iterable

Segment = tuple[float, float, str]


def _format_timestamp(seconds: float, ms_separator: str) -> str:
    total_ms = round(seconds * 1000)
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{ms_separator}{millis:03d}"


def format_srt(segments: Iterable[Segment]) -> str:
    cues: list[str] = []
    for idx, (start, end, text) in enumerate(segments, start=1):
        cues.append(
            f"{idx}\n"
            f"{_format_timestamp(start, ',')} --> {_format_timestamp(end, ',')}\n"
            f"{text}\n"
        )
    if not cues:
        return ""
    return "\n".join(cues) + "\n"


def format_vtt(segments: Iterable[Segment]) -> str:
    cues: list[str] = []
    for start, end, text in segments:
        cues.append(
            f"{_format_timestamp(start, '.')} --> {_format_timestamp(end, '.')}\n"
            f"{text}\n"
        )
    body = "\n".join(cues)
    if body:
        body += "\n"
    return f"WEBVTT\n\n{body}"
