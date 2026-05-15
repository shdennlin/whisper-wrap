"""CTranslate2 backend (faster-whisper) — Linux default + macOS fallback.

Conforms to `app.services._whisper_backend.WhisperBackend` Protocol.

This module owns the in-process `faster_whisper.WhisperModel` wrapping logic.
A FastAPI lifespan instantiates exactly one `CTranslate2Backend` per process
when the active variant's `format` field is `ct2`.

Migration note: the legacy `app.services.whisper.WhisperClient` adapter keeps
the dict-based return shape for callers that haven't moved to
`TranscriptionResult` yet; that adapter is removed in task 7.3.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

import numpy as np
from faster_whisper import WhisperModel

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


def _validate_ct2_directory(model_dir: str) -> None:
    """Pre-flight: a CT2 directory must contain `model.bin` and at least one tokenizer file."""
    path = Path(model_dir)
    if not (path / "model.bin").is_file():
        raise WhisperLoadError(
            f"CT2 model directory {model_dir!r} is missing model.bin"
        )
    has_tokenizer = (path / "tokenizer.json").is_file() or (
        path / "vocabulary.json"
    ).is_file()
    if not has_tokenizer:
        raise WhisperLoadError(
            f"CT2 model directory {model_dir!r} is missing tokenizer (tokenizer.json or vocabulary.json)"
        )


def _run_inference(
    model: WhisperModel,
    media: Any,
    *,
    language: str | None,
    initial_prompt: str | None,
    task: str = "transcribe",
) -> tuple[list, Any]:
    """Run the synchronous model inference and materialise segments inside a thread."""
    segments, info = model.transcribe(
        media, language=language, initial_prompt=initial_prompt, task=task
    )
    return list(segments), info


class CTranslate2Backend:
    """`WhisperBackend` implementation backed by `faster_whisper.WhisperModel`.

    Instantiate with either:
      - `model=<existing WhisperModel>` (test fixture or pre-loaded instance), or
      - `model_dir=<directory>` plus optional `compute_type` / `device` — the backend
        constructs the WhisperModel itself and wraps any error in `WhisperLoadError`.

    Sync inference is dispatched to `asyncio.to_thread` so the event loop stays free.
    """

    def __init__(
        self,
        *,
        model: WhisperModel | None = None,
        model_dir: str | None = None,
        compute_type: str = "default",
        device: str = "auto",
    ):
        if model is None and model_dir is None:
            raise ValueError("CTranslate2Backend requires either model or model_dir")

        if model is not None:
            self._model = model
            return

        _validate_ct2_directory(model_dir)
        try:
            self._model = WhisperModel(
                model_dir, compute_type=compute_type, device=device
            )
        except Exception as e:
            raise WhisperLoadError(
                f"Failed to load WhisperModel from {model_dir}: {e}"
            ) from e

    async def transcribe(
        self,
        wav_path: Path,
        *,
        language: str = "auto",
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> TranscriptionResult:
        """Transcribe a WAV file. Returns a `TranscriptionResult` dataclass.

        `task="translate"` invokes faster-whisper's translation mode (output
        in English). Default `task="transcribe"` preserves prior behaviour.
        """
        if not wav_path.exists():
            raise FileNotFoundError(f"WAV file not found: {wav_path}")

        model_language = None if language == "auto" else language

        try:
            segment_list, info = await asyncio.to_thread(
                _run_inference,
                self._model,
                str(wav_path),
                language=model_language,
                initial_prompt=initial_prompt,
                task=task,
            )
        except Exception as e:
            raise WhisperTranscriptionError(f"{e}") from e

        return self._build_result(segment_list, info)

    async def transcribe_pcm(
        self,
        samples: np.ndarray,
        *,
        language: str = "auto",
    ) -> TranscriptionResult:
        """Transcribe a float32 16 kHz mono PCM array. Returns a `TranscriptionResult`."""
        model_language = None if language == "auto" else language

        try:
            segment_list, info = await asyncio.to_thread(
                _run_inference,
                self._model,
                samples,
                language=model_language,
                initial_prompt=None,
            )
        except Exception as e:
            raise WhisperTranscriptionError(f"{e}") from e

        return self._build_result(segment_list, info)

    @staticmethod
    def _build_result(segment_list: list, info: Any) -> TranscriptionResult:
        raw_text = "".join(seg.text for seg in segment_list).strip()
        detected_lang = info.language or detect_text_language(raw_text)
        joined = join_newline_segments(raw_text)
        normalized = normalize_punctuation(joined, detected_lang)

        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(
                "Transcription result:\n  raw: %r\n  detected: %s\n  normalized: %r",
                raw_text,
                detected_lang,
                normalized,
            )

        return TranscriptionResult(
            text=normalized,
            segments=[
                Segment(text=seg.text, start=seg.start, end=seg.end)
                for seg in segment_list
            ],
            language=detected_lang,
            duration_seconds=getattr(info, "duration", 0.0) or 0.0,
        )
