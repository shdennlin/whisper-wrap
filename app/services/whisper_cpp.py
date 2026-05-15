"""pywhispercpp backend — macOS default (Core ML / Apple Neural Engine).

Conforms to `app.services._whisper_backend.WhisperBackend` Protocol.

Module-level platform guard: import on a non-darwin host raises `WhisperLoadError`
instead of a raw ImportError. The `pywhispercpp` package itself is gated by the
`sys_platform == "darwin"` marker in `pyproject.toml`, but a stale install or
manual override could still reach the import — the guard ensures every failure
mode surfaces through the standard Protocol error type.

Core ML acceleration: pywhispercpp auto-detects the encoder when a
`ggml-<name>-encoder.mlmodelc` directory sits alongside the `.bin` file. The
`coreml_encoder` constructor argument is used for the existence pre-flight check
(the design contract guarantees a useful error before the underlying library
silently falls back to CPU-only ggml decode).
"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

from app.services._whisper_backend import (
    Segment,
    TranscriptionResult,
    WhisperLoadError,
    WhisperTranscriptionError,
)
from app.services.punctuation import (
    detect_text_language,
    join_newline_segments,
    normalize_punctuation,
)

logger = logging.getLogger(__name__)


if sys.platform != "darwin":
    raise WhisperLoadError(
        f"pywhispercpp is not available on {sys.platform}; "
        "set BACKEND_FORMAT=ct2 or run on macOS"
    )

# Imported only after the platform guard so a misconfigured Linux install gets
# the typed Whisper error instead of an opaque ImportError chain.
from pywhispercpp.model import Model  # noqa: E402


class PyWhisperCppBackend:
    """`WhisperBackend` implementation backed by `pywhispercpp.model.Model`.

    Construction is synchronous (model load is done in the calling thread); the
    transcribe / transcribe_pcm methods dispatch the synchronous inference call
    to `asyncio.to_thread`.
    """

    def __init__(
        self,
        *,
        model_path: str,
        coreml_encoder: str | None,
        n_threads: int = 4,
        **extra_params: Any,
    ):
        ggml_path = Path(model_path)
        if not ggml_path.is_file():
            raise WhisperLoadError(
                f"pywhispercpp ggml model not found at {model_path}; "
                f"run `make download-model MODEL=<name>` to fetch it"
            )

        if coreml_encoder is not None and not Path(coreml_encoder).is_dir():
            raise WhisperLoadError(
                f"Core ML encoder directory missing at {coreml_encoder}; "
                f"run `make download-model MODEL=<name>` to fetch it"
            )

        self._model_path = str(ggml_path)
        self._coreml_encoder = coreml_encoder
        self._n_threads = n_threads
        self._extra_params = extra_params

        # First-run Core ML encoder compile (~10-30 s on a fresh host) happens
        # synchronously inside Model() construction. Run the load in a background
        # thread and emit one INFO log per second of elapsed wall-clock so
        # operators see progress (and aren't confused that startup hung).
        # Decision 5: Block lifespan on first-run Core ML encoder compile.
        t0 = time.monotonic()
        logger.info(
            "Loading pywhispercpp model %s (coreml=%s, n_threads=%d)",
            self._model_path,
            "yes" if coreml_encoder else "no",
            n_threads,
        )

        result: dict[str, Any] = {}
        done_event = threading.Event()
        encoder_label = coreml_encoder or "(cpu-only)"

        def _load_worker() -> None:
            try:
                result["model"] = Model(
                    model=self._model_path,
                    n_threads=n_threads,
                    print_progress=False,
                    print_realtime=False,
                    print_timestamps=False,
                    **extra_params,
                )
            except BaseException as exc:  # noqa: BLE001 — surface anything load fails with
                result["error"] = exc
            finally:
                done_event.set()

        loader = threading.Thread(target=_load_worker, daemon=True)
        loader.start()

        # Tick every 1 s until load completes.
        while not done_event.wait(timeout=1.0):
            elapsed_int = int(time.monotonic() - t0)
            logger.info(
                "compiling Core ML encoder %s ... (%ds elapsed)",
                encoder_label,
                elapsed_int,
            )

        loader.join()

        if "error" in result:
            raise WhisperLoadError(
                f"Failed to load pywhispercpp Model from {model_path}: {result['error']}"
            ) from result["error"]

        self._model = result["model"]
        elapsed = time.monotonic() - t0
        logger.info(
            "pywhispercpp compile complete in %.1fs (coreml=%s)",
            elapsed,
            "yes" if coreml_encoder else "no",
        )

    @property
    def coreml_encoder_compiled(self) -> bool:
        """True when the Core ML encoder was provided to the constructor.

        pywhispercpp auto-detects the encoder when the `.mlmodelc` sits alongside
        the ggml `.bin`; we surface a hint to `/status` based on the constructor
        argument rather than introspecting the loaded library (which the upstream
        binding does not expose).
        """
        return self._coreml_encoder is not None

    async def transcribe(
        self,
        wav_path: Path,
        *,
        language: str = "auto",
        initial_prompt: str | None = None,
    ) -> TranscriptionResult:
        """Transcribe a WAV file. Returns a `TranscriptionResult`."""
        if not wav_path.exists():
            raise FileNotFoundError(f"WAV file not found: {wav_path}")

        params = self._build_params(language=language, initial_prompt=initial_prompt)
        try:
            segments = await asyncio.to_thread(
                self._model.transcribe, str(wav_path), **params
            )
        except Exception as e:
            raise WhisperTranscriptionError(f"{e}") from e

        return self._build_result(segments, requested_language=language)

    async def transcribe_pcm(
        self,
        samples: np.ndarray,
        *,
        language: str = "auto",
    ) -> TranscriptionResult:
        """Transcribe a float32 16 kHz mono PCM array. Returns a `TranscriptionResult`."""
        params = self._build_params(language=language, initial_prompt=None)
        try:
            segments = await asyncio.to_thread(
                self._model.transcribe, samples, **params
            )
        except Exception as e:
            raise WhisperTranscriptionError(f"{e}") from e

        return self._build_result(segments, requested_language=language)

    def _build_params(
        self, *, language: str, initial_prompt: str | None
    ) -> dict[str, Any]:
        # pywhispercpp accepts `language` directly; "auto" is its sentinel too.
        params: dict[str, Any] = {"language": language}
        if initial_prompt is not None:
            params["initial_prompt"] = initial_prompt
        return params

    def _build_result(
        self, segments: list, *, requested_language: str
    ) -> TranscriptionResult:
        """Map pywhispercpp `Segment` (t0/t1 in centiseconds) to our dataclass."""
        raw_text = "".join(getattr(s, "text", "") for s in segments).strip()

        # pywhispercpp does not return language-detection metadata; fall back to
        # the requested language or a text-based detection so callers get a
        # non-empty `language` field.
        detected_lang = (
            None if requested_language == "auto" else requested_language
        )
        if detected_lang is None:
            detected_lang = detect_text_language(raw_text)

        joined = join_newline_segments(raw_text)
        normalized = normalize_punctuation(joined, detected_lang)

        mapped_segments = [
            Segment(text=s.text, start=s.t0 / 100.0, end=s.t1 / 100.0)
            for s in segments
        ]
        duration = mapped_segments[-1].end if mapped_segments else 0.0

        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(
                "Transcription result (ggml):\n  raw: %r\n  lang: %s\n  normalized: %r",
                raw_text,
                detected_lang,
                normalized,
            )

        return TranscriptionResult(
            text=normalized,
            segments=mapped_segments,
            language=detected_lang,
            duration_seconds=duration,
        )
