"""Voice Activity Detection (VAD) backends for `WS /listen`.

Two backends ship in v2.2:

  - `RmsVad`     — int16 RMS-energy threshold (preserved from v2.1 for
                   benchmarks, constrained hosts, and as the auto-fallback
                   when silero-vad cannot be imported).
  - `SileroVad`  — wraps the open-source `silero-vad` neural model (TorchScript
                   bundle loaded via `silero_vad.load_silero_vad()`). Slices
                   each 250 ms client frame into 32 ms (512-sample) chunks
                   before submitting to the model — any chunk classified as
                   speech makes the whole client frame "voice" for the
                   surrounding silence-duration accumulator in `stream.py`.

`StreamSession` operates against the `VadBackend` Protocol surface only —
the WS handler in `app/api/listen.py` constructs a fresh `VadBackend` per
session via `app.state.vad_factory()` so silero-vad's internal LSTM state
never leaks across concurrent connections.

Selection: see `make_vad_backend(name)` for the env-var precedence.
"""

from __future__ import annotations

import logging
import struct
from typing import Protocol, runtime_checkable

logger = logging.getLogger(__name__)


# Match the v2.1 inline default. Tuned for typical condenser mic at 16 kHz.
DEFAULT_RMS_THRESHOLD = 500.0

SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2
SILERO_CHUNK_SAMPLES = 512  # 32 ms at 16 kHz — silero-recommended frame size
SILERO_DEFAULT_THRESHOLD = 0.5  # silero's own published default


@runtime_checkable
class VadBackend(Protocol):
    """Abstract voice-activity classifier.

    Implementations classify each incoming PCM frame (`pcm_s16le`, 16 kHz mono)
    as speech (True) or non-speech (False). The protocol does NOT prescribe
    constructor arguments — each backend accepts its own configuration.
    """

    def is_speech(self, pcm: bytes) -> bool:
        """Return True if the frame contains speech, False otherwise."""
        ...


def compute_rms(pcm: bytes) -> float:
    """Root-mean-square of an int16 little-endian PCM buffer.

    Re-exported from this module so `tests/test_listen.py` can keep using
    the same RMS calculation it depended on in v2.1.
    """
    if not pcm:
        return 0.0
    n = len(pcm) // 2
    samples = struct.unpack(f"<{n}h", pcm[: n * 2])
    return (sum(s * s for s in samples) / n) ** 0.5


class RmsVad:
    """Int16 RMS-energy classifier (v2.1 behaviour).

    Cheap (no model, no torch). Used as the explicit opt-out backend and as
    the auto-fallback when silero-vad is unavailable.
    """

    def __init__(self, threshold: float = DEFAULT_RMS_THRESHOLD) -> None:
        self._threshold = threshold

    def is_speech(self, pcm: bytes) -> bool:
        return compute_rms(pcm) >= self._threshold


class SileroVad:
    """Neural VAD using the silero-vad TorchScript model.

    Per Decision 4, each client frame is sliced into 32 ms (512-sample) chunks
    before submission to the model. Any chunk above the speech-probability
    threshold (default 0.5) makes the whole frame "voice".

    Constructor lazy-loads the model so importing this module does not pay the
    torch.hub cost. The model holds per-instance state (LSTM hidden state)
    that must not be shared across WS sessions — `make_vad_backend()` returns
    a fresh instance per call, and `app/api/listen.py` calls the factory per
    session.
    """

    def __init__(self, threshold: float = SILERO_DEFAULT_THRESHOLD) -> None:
        # Defer the torch + silero_vad imports so RMS-only deployments do not
        # pay the cost. Errors bubble up as ImportError so the factory can
        # decide whether to fall back.
        import torch  # noqa: F401 — explicit dependency check
        from silero_vad import load_silero_vad

        self._threshold = threshold
        self._model = load_silero_vad()
        # Cache torch reference for tensor conversion without re-import.
        import torch as _torch

        self._torch = _torch

    def is_speech(self, pcm: bytes) -> bool:
        if not pcm:
            return False
        n_samples = len(pcm) // BYTES_PER_SAMPLE
        if n_samples == 0:
            return False

        # Convert pcm_s16le to a float tensor in [-1, 1].
        samples = (
            self._torch.frombuffer(bytearray(pcm), dtype=self._torch.int16).float()
            / 32768.0
        )

        # Slice into 512-sample chunks; classify each; any-speech-in-frame wins.
        for start in range(
            0, n_samples - SILERO_CHUNK_SAMPLES + 1, SILERO_CHUNK_SAMPLES
        ):
            chunk = samples[start : start + SILERO_CHUNK_SAMPLES]
            with self._torch.no_grad():
                prob = self._model(chunk, SAMPLE_RATE).item()
            if prob >= self._threshold:
                return True
        return False


def make_vad_backend(name: str | None) -> VadBackend:
    """Resolve a VAD backend per the `VAD_BACKEND` env var precedence.

      1. name == "rms"     → RmsVad() unconditionally; never imports silero_vad.
      2. name == "silero"  → SileroVad(); fails with RuntimeError if import fails.
      3. name is None / "" → try SileroVad first, fall back to RmsVad with one
                             INFO log line if silero_vad cannot be imported.
      4. anything else     → RuntimeError listing accepted values.

    Raises:
        RuntimeError when an explicit `silero` request fails to import or
        when the value is not one of {None, "", "rms", "silero"}.
    """
    if name is None or name == "":
        try:
            return SileroVad()
        except ImportError as e:
            logger.info("silero-vad unavailable, falling back to rms (%s)", e)
            return RmsVad()
    if name == "rms":
        return RmsVad()
    if name == "silero":
        try:
            return SileroVad()
        except ImportError as e:
            raise RuntimeError(
                f"VAD_BACKEND=silero requested but silero-vad is not installed; "
                f"install with: uv add silero-vad ({e})"
            ) from e
    raise RuntimeError(
        f"VAD_BACKEND={name!r} is not recognised; accepted values: silero, rms"
    )
