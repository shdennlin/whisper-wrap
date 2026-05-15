"""Embedded sliding-window streaming wrapper for `WS /listen`.

Implements the design decision "Embed a sliding-window streaming wrapper instead
of depending on an upstream `whisper-streaming` package". Maintains a per-session
PCM buffer, runs lightweight RMS-energy VAD to endpoint utterances, periodically
re-transcribes the active utterance via the shared `WhisperBackend.transcribe_pcm`,
and emits `partial` / `final` / `warning` events through a caller-supplied
async callback.

v2.1: a `PartialConsensusFilter` (Decision 6 — simplified LocalAgreement-2)
suppresses `partial` events until two consecutive inferences agree on a prefix
that ends at a word boundary. Cuts partial-emission rate by ≥50% and removes
the visible text-thrashing problem v2 had.
"""

import asyncio
import logging
import string
import struct
from collections.abc import Awaitable, Callable
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


# pcm_s16le @ 16 kHz mono
SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2

# Streaming knobs (per design decision; tuned for ~250 ms client frame cadence)
SILENCE_RMS_THRESHOLD = 500.0   # int16 RMS — anything below is silence
SILENCE_DURATION_MS = 700       # consecutive silence required to end an utterance
PARTIAL_INTERVAL_MS = 500       # min interval between partials during active speech
PARTIAL_WINDOW_MS = 5000        # partial inference looks at last N ms of audio only (bounded cost)
MAX_BUFFER_SECONDS = 30
MAX_BUFFER_BYTES = MAX_BUFFER_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE
PARTIAL_WINDOW_BYTES = (PARTIAL_WINDOW_MS * SAMPLE_RATE * BYTES_PER_SAMPLE) // 1000


TranscribeFn = Callable[[np.ndarray], Awaitable[str]]
SendEventFn = Callable[[dict[str, Any]], Awaitable[None]]


def compute_rms(pcm: bytes) -> float:
    """Root-mean-square of an int16 little-endian PCM buffer."""
    if not pcm:
        return 0.0
    n = len(pcm) // 2
    samples = struct.unpack(f"<{n}h", pcm[: n * 2])
    return (sum(s * s for s in samples) / n) ** 0.5


def pcm_to_float32(pcm: bytes) -> np.ndarray:
    """Convert int16 LE PCM bytes to a float32 NumPy array in [-1, 1]."""
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


def frame_duration_ms(pcm: bytes) -> int:
    """Duration in ms of a `pcm_s16le` 16 kHz mono frame."""
    n_samples = len(pcm) // BYTES_PER_SAMPLE
    return (n_samples * 1000) // SAMPLE_RATE


# ---------- Partial-consensus filter (v2.1, Decision 6) ----------


_PUNCT_CHARS = set(string.punctuation) | set("。，！？；：、「」『』（）《》—…")


def _is_word_boundary(ch: str) -> bool:
    """A character that ends a "word" for partial-consensus purposes.

    Whitespace and ASCII/CJK punctuation are explicit boundaries. CJK ideographs
    (Han, Hiragana, Katakana, etc.) are also boundaries because CJK does not
    use whitespace between words — each ideograph is itself a complete word.
    """
    if ch.isspace() or ch in _PUNCT_CHARS:
        return True
    code = ord(ch)
    # CJK Unified Ideographs, Hiragana, Katakana, Hangul, CJK Symbols
    return (
        0x3000 <= code <= 0x303F  # CJK Symbols and Punctuation
        or 0x3040 <= code <= 0x30FF  # Hiragana + Katakana
        or 0x3400 <= code <= 0x4DBF  # CJK Unified Ideographs Extension A
        or 0x4E00 <= code <= 0x9FFF  # CJK Unified Ideographs
        or 0xAC00 <= code <= 0xD7AF  # Hangul Syllables
        or 0xFF00 <= code <= 0xFFEF  # Halfwidth/Fullwidth Forms
    )


def compute_lcp_at_word_boundary(prev: str, curr: str) -> str:
    """Longest common prefix of `prev` and `curr` truncated to end at a word boundary.

    Returns the empty string when the truncation produces less than 2 characters
    of useful prefix — emitting a 1-character partial is rarely worth the
    bandwidth and tends to thrash the UI.

    Rules:
      1. Compute the raw LCP character-by-character.
      2. If `curr[len(LCP)]` is itself a word boundary (or LCP reached the end
         of `curr`), the LCP ends cleanly — return it as-is.
      3. Otherwise the LCP ends mid-word; walk backwards looking for the last
         word boundary inside LCP. Trim to chars before that boundary.
      4. If the trimmed prefix is shorter than 2 characters, return "".
    """
    if not prev or not curr:
        return ""

    # Step 1: raw LCP
    n = min(len(prev), len(curr))
    lcp_len = 0
    for i in range(n):
        if prev[i] != curr[i]:
            break
        lcp_len = i + 1
    if lcp_len == 0:
        return ""

    # Step 2: does the LCP end at a clean boundary?
    if lcp_len == len(curr) or _is_word_boundary(curr[lcp_len]):
        return prev[:lcp_len]

    # Step 3: walk backwards for the last boundary inside the LCP
    lcp = prev[:lcp_len]
    last_boundary = -1
    for i in range(lcp_len - 1, -1, -1):
        if _is_word_boundary(lcp[i]):
            last_boundary = i
            break
    if last_boundary == -1:
        return ""
    trimmed = lcp[:last_boundary]
    # Step 4: discard single-character "progress"
    if len(trimmed.strip()) < 2:
        return ""
    return trimmed


class PartialConsensusFilter:
    """Single-step consensus filter for `partial` events.

    Holds the previous inference's transcript and the last-emitted partial text.
    `update(current)` returns the partial text to emit (or None to suppress).

    Caller protocol per spec:
      - On every sliding-window inference, call `update(current_transcript)`.
      - If the return value is non-None, emit a `partial` event with that text.
      - Reset state with `reset()` at utterance boundaries (e.g. after `final`).
    """

    def __init__(self) -> None:
        self._prev: str | None = None
        self._last_emitted: str | None = None

    def update(self, current: str) -> str | None:
        """Return the partial text to emit, or None to suppress.

        First inference of an utterance: emit current verbatim — "no previous
        to disagree with" is treated as "trivially agrees", so users see
        feedback immediately instead of waiting one extra inference window.
        Subsequent inferences apply the LCP-at-word-boundary truncation +
        dedup against the most recently emitted partial.
        """
        prev = self._prev
        self._prev = current
        if not current:
            return None
        if prev is None:
            # First inference: emit verbatim (no consensus needed yet).
            # Trim trailing whitespace so the displayed text has no dangling
            # boundary characters — same shape downstream consumers expect.
            text = current.rstrip()
            if not text or text == self._last_emitted:
                return None
            self._last_emitted = text
            return text
        truncated = compute_lcp_at_word_boundary(prev, current)
        if not truncated or truncated == self._last_emitted:
            return None
        self._last_emitted = truncated
        return truncated

    def reset(self) -> None:
        self._prev = None
        self._last_emitted = None


class NullConsensusFilter:
    """No-op filter — every inference passes through verbatim.

    Used by the Phase 2 regression test (`test_partial_count_ratio_le_half`)
    to measure the v2 baseline: how many `partial` events would fire if the
    consensus filter were not present. Production code should never use this.
    """

    def update(self, current: str) -> str | None:
        return current if current else None

    def reset(self) -> None:
        pass


class StreamSession:
    """State for a single `WS /listen` session.

    A connection may carry multiple utterances back-to-back. Timestamps are
    measured in *audio time* (accumulated milliseconds of PCM received) so they
    are deterministic regardless of how fast the client streams frames — and so
    the spec's scenario timestamps reflect audio duration, not wall clock.
    """

    def __init__(
        self,
        *,
        transcribe_fn: TranscribeFn,
        send_event: SendEventFn,
        consensus_filter: PartialConsensusFilter | None = None,
    ) -> None:
        self.transcribe_fn = transcribe_fn
        self.send_event = send_event
        # Default-on in v2.1; pass consensus_filter=None at construction to disable
        # for the regression benchmark (`tests/test_stream_consensus.py`).
        self.consensus_filter = (
            consensus_filter if consensus_filter is not None
            else PartialConsensusFilter()
        )
        self._audio_ms = 0
        self._utterance_buffer = bytearray()
        self._utterance_start_ms = 0
        self._last_partial_ms = 0
        self._last_voice_ms = 0
        self._in_utterance = False
        self._overflow_warning_pending = False
        # Async backpressure: when a partial inference is in flight, drop the
        # next partial cadence rather than queueing more inference behind it.
        self._partial_in_flight: asyncio.Task | None = None

    def elapsed_ms(self) -> int:
        return self._audio_ms

    async def drain(self) -> None:
        """Wait for any in-flight partial inference to complete.

        Used by tests + clean shutdown so deterministic assertions can observe
        the events that a fire-and-forget partial inference will eventually
        emit. Production WS handlers do not need to call this — the WebSocket
        loop drains naturally on disconnect.
        """
        if self._partial_in_flight is not None and not self._partial_in_flight.done():
            try:
                await self._partial_in_flight
            except Exception:
                logger.exception("Pending partial inference raised during drain")

    async def feed_frame(self, pcm: bytes) -> None:
        """Append a PCM frame and emit any cadence-triggered events."""
        # Backpressure: cap utterance buffer at 30 s. Drop oldest on overflow and
        # emit a single warning per overflow event (NOT per dropped frame).
        if len(self._utterance_buffer) + len(pcm) > MAX_BUFFER_BYTES:
            overflow = len(self._utterance_buffer) + len(pcm) - MAX_BUFFER_BYTES
            self._utterance_buffer = self._utterance_buffer[overflow:]
            if not self._overflow_warning_pending:
                await self.send_event(
                    {"type": "warning", "message": "buffer overflow, oldest audio dropped"}
                )
                self._overflow_warning_pending = True

        self._utterance_buffer.extend(pcm)
        self._audio_ms += frame_duration_ms(pcm)
        now_ms = self._audio_ms
        rms = compute_rms(pcm)

        # Voice activity detection
        if rms >= SILENCE_RMS_THRESHOLD:
            self._last_voice_ms = now_ms
            if not self._in_utterance:
                # Start a new utterance — discard accumulated pre-roll silence and
                # anchor the utterance buffer at the current frame.
                self._in_utterance = True
                self._utterance_start_ms = now_ms
                self._last_partial_ms = now_ms
                self._utterance_buffer = bytearray(pcm)
                self._overflow_warning_pending = False

        if not self._in_utterance:
            # Trim the silence buffer aggressively while no utterance is active.
            if len(self._utterance_buffer) > BYTES_PER_SAMPLE * SAMPLE_RATE:
                # Keep last 1 second to anchor possible utterance start.
                tail = BYTES_PER_SAMPLE * SAMPLE_RATE
                self._utterance_buffer = self._utterance_buffer[-tail:]
            return

        final_due = (now_ms - self._last_voice_ms) >= SILENCE_DURATION_MS
        partial_due = (now_ms - self._last_partial_ms) >= PARTIAL_INTERVAL_MS

        # Final supersedes partial: when a final is due, skip any partial that
        # would otherwise fire on the same frame (the final carries the full
        # transcript anyway, and a partial-then-final pair is visual noise).
        if partial_due and not final_due:
            # Drop the cadence fire if a previous partial inference is still
            # running. Better to skip a frame than queue inference and let
            # latency accumulate while the user keeps speaking.
            if self._partial_in_flight is None or self._partial_in_flight.done():
                self._last_partial_ms = now_ms
                self._partial_in_flight = asyncio.create_task(
                    self._run_partial_inference(now_ms)
                )
            else:
                logger.debug(
                    "Partial cadence skipped at audio_ms=%d (inference still running)",
                    now_ms,
                )

        if final_due:
            # Wait for any in-flight partial so emit order stays partial→final.
            if self._partial_in_flight is not None and not self._partial_in_flight.done():
                try:
                    await self._partial_in_flight
                except Exception:
                    logger.exception("Pending partial inference failed before final")
            await self._emit_final(now_ms)
            self._in_utterance = False
            self._utterance_buffer = bytearray()
            self.consensus_filter.reset()
            self._partial_in_flight = None

    async def _run_partial_inference(self, end_ms: int) -> None:
        """Run a partial-window inference and emit (fire-and-forget from feed_frame).

        Uses only the tail of the utterance buffer (last PARTIAL_WINDOW_MS) so
        inference cost is bounded regardless of how long the utterance has been
        running. Final-event inference still uses the full buffer for accuracy.
        """
        if not self._utterance_buffer:
            return

        # Tail-window: only look at the most recent PARTIAL_WINDOW_MS of audio.
        if len(self._utterance_buffer) > PARTIAL_WINDOW_BYTES:
            tail = bytes(self._utterance_buffer[-PARTIAL_WINDOW_BYTES:])
            window_start_ms = max(self._utterance_start_ms, end_ms - PARTIAL_WINDOW_MS)
        else:
            tail = bytes(self._utterance_buffer)
            window_start_ms = self._utterance_start_ms

        samples = pcm_to_float32(tail)
        try:
            text = await self.transcribe_fn(samples)
        except Exception as e:
            logger.exception("Partial transcription failed: %s", e)
            return

        filtered = self.consensus_filter.update(text)
        if filtered is None:
            return

        await self.send_event(
            {
                "type": "partial",
                "text": filtered,
                "start_ms": window_start_ms,
                "end_ms": end_ms,
            }
        )

    async def _emit_final(self, end_ms: int) -> None:
        """Final event: transcribe the FULL utterance buffer for best accuracy."""
        if not self._utterance_buffer:
            return
        samples = pcm_to_float32(bytes(self._utterance_buffer))
        try:
            text = await self.transcribe_fn(samples)
        except Exception as e:
            logger.exception("Final transcription failed: %s", e)
            return
        await self.send_event(
            {
                "type": "final",
                "text": text,
                "start_ms": self._utterance_start_ms,
                "end_ms": end_ms,
            }
        )
