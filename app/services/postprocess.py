"""Transcription post-process filter.

Single source of truth for the decision: is this Whisper output noise or content?
Used by /listen, /transcribe, /ask, and the OpenAI-compat endpoints so the
empty/punctuation/silence rules stay aligned across surfaces.

This module is pure — no logging, no I/O, no config reads. Callers (HTTP/WS
handlers) read config and emit `transcription_filtered` log lines on Drop.

The empty-text check strips:
  - All Unicode whitespace via `str.isspace()`.
  - A hand-rolled set of ASCII + CJK punctuation. We avoid the `regex` library
    (not in deps) and `unicodedata.category(c) == "P*"` (would also drop
    apostrophes inside English words like "don't"). The hand-rolled set covers
    the Whisper hallucination cases we actually see; extend it when new
    failure modes surface.
"""

from dataclasses import dataclass
from typing import Literal

_PUNCT_CHARS: frozenset[str] = frozenset(
    ".,!?;:'\"`-_*~/\\()[]{}<>"  # ASCII punctuation Whisper emits
    "。，、；：？！「」『』（）《》〈〉…—·"  # CJK punctuation Whisper emits
)


@dataclass(frozen=True)
class Keep:
    text: str


@dataclass(frozen=True)
class Drop:
    reason: Literal["empty_text", "below_min_duration"]


FilterDecision = Keep | Drop


def filter_empty_transcription(
    text: str,
    duration_ms: float | None,
    *,
    enabled: bool,
    min_duration_ms: int,
) -> FilterDecision:
    """Decide whether a transcription result is content or noise.

    Args:
        text: Raw text from the WhisperBackend.
        duration_ms: Source audio duration in milliseconds, or None when the
            caller did not measure it (e.g. /transcribe). When None the
            duration check is skipped.
        enabled: When False, always returns `Keep(text)` (kill-switch).
        min_duration_ms: Minimum acceptable utterance duration. Must be >= 0.

    Returns:
        `Keep(text)` if the transcription is content, or `Drop(reason)` if it
        should be suppressed. `Keep.text` is the ORIGINAL text — no stripping.

    Raises:
        ValueError: if `min_duration_ms` is negative.
    """
    if min_duration_ms < 0:
        raise ValueError(f"min_duration_ms must be non-negative; got {min_duration_ms}")

    if not enabled:
        return Keep(text)

    if duration_ms is not None and duration_ms < min_duration_ms:
        return Drop("below_min_duration")

    if _is_empty_after_stripping(text):
        return Drop("empty_text")

    return Keep(text)


def _is_empty_after_stripping(text: str) -> bool:
    """Return True when text contains nothing but whitespace and punctuation."""
    for ch in text:
        if ch.isspace():
            continue
        if ch in _PUNCT_CHARS:
            continue
        return False
    return True
