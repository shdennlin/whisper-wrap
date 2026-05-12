"""Embedded sliding-window streaming wrapper for `WS /listen`.

Implements the design decision "Embed a sliding-window streaming wrapper instead
of depending on an upstream `whisper-streaming` package". Maintains a per-session
PCM buffer, runs lightweight RMS-energy VAD to endpoint utterances, periodically
re-transcribes the active utterance via the shared `WhisperClient.transcribe_pcm`,
and emits `partial` / `final` / `warning` events through a caller-supplied
async callback.
"""

import logging
import struct
from typing import Any, Awaitable, Callable

import numpy as np

logger = logging.getLogger(__name__)


# pcm_s16le @ 16 kHz mono
SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2

# Streaming knobs (per design decision; tuned for ~250 ms client frame cadence)
SILENCE_RMS_THRESHOLD = 500.0  # int16 RMS — anything below is silence
SILENCE_DURATION_MS = 700      # consecutive silence required to end an utterance
PARTIAL_INTERVAL_MS = 500      # min interval between partials during active speech
MAX_BUFFER_SECONDS = 30
MAX_BUFFER_BYTES = MAX_BUFFER_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE


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
    ) -> None:
        self.transcribe_fn = transcribe_fn
        self.send_event = send_event
        self._audio_ms = 0
        self._utterance_buffer = bytearray()
        self._utterance_start_ms = 0
        self._last_partial_ms = 0
        self._last_voice_ms = 0
        self._in_utterance = False
        self._overflow_warning_pending = False

    def elapsed_ms(self) -> int:
        return self._audio_ms

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

        # Emit partial transcripts on cadence.
        if (now_ms - self._last_partial_ms) >= PARTIAL_INTERVAL_MS:
            await self._emit_event("partial", now_ms)
            self._last_partial_ms = now_ms

        # Endpoint detection: silence longer than SILENCE_DURATION_MS finalises.
        if (now_ms - self._last_voice_ms) >= SILENCE_DURATION_MS:
            await self._emit_event("final", now_ms)
            self._in_utterance = False
            self._utterance_buffer = bytearray()

    async def _emit_event(self, event_type: str, end_ms: int) -> None:
        if not self._utterance_buffer:
            return
        samples = pcm_to_float32(bytes(self._utterance_buffer))
        try:
            text = await self.transcribe_fn(samples)
        except Exception as e:
            logger.exception("Streaming transcription failed: %s", e)
            return
        await self.send_event(
            {
                "type": event_type,
                "text": text,
                "start_ms": self._utterance_start_ms,
                "end_ms": end_ms,
            }
        )
