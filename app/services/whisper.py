"""In-process faster-whisper wrapper (v2 backend).

Replaces the v1 HTTP client to a separate `whisper-server` subprocess. The wrapper
holds a single shared `WhisperModel` instance constructed at app startup
(see `app/main.py` lifespan) and exposes the same `WhisperClient.transcribe()`
contract that the v1 callers depended on.
"""

import asyncio
import logging
from pathlib import Path
from typing import Any

from faster_whisper import WhisperModel

from app.services.punctuation import (
    detect_text_language,
    join_newline_segments,
    normalize_punctuation,
)

logger = logging.getLogger(__name__)

# Whisper imitates the style of the prompt, so a bilingual punctuated seed nudges
# the model toward properly-punctuated output. Capped at 224 tokens per the model card.
_DEFAULT_PUNCTUATION_PROMPT = (
    "以下是語音轉錄的內容，包含正確的標點符號。"
    "Hello, this is a transcription. We use commas, periods, and question marks. "
    "這段文字有逗號、句號、問號？都是正確的標點。"
)


class WhisperLoadError(RuntimeError):
    """The configured WhisperModel could not be constructed (missing files, bad path, etc.)."""


class WhisperTranscriptionError(RuntimeError):
    """In-process transcription failed at runtime."""


def load_model(
    model_dir: str, *, compute_type: str = "default", device: str = "auto"
) -> WhisperModel:
    """Construct a `WhisperModel`; raise `WhisperLoadError` with the underlying cause attached.

    `compute_type="default"` lets CT2 pick the best runtime path for the device — required
    on Apple Silicon CPU because `int8_float16` storage does not map 1:1 to a CPU compute path.
    """
    try:
        return WhisperModel(model_dir, compute_type=compute_type, device=device)
    except Exception as e:
        raise WhisperLoadError(f"Failed to load WhisperModel from {model_dir}: {e}") from e


def _run_inference(
    model: WhisperModel,
    file_path: str,
    *,
    language: str | None,
    initial_prompt: str,
) -> tuple[list, Any]:
    """Run the synchronous model inference and materialise segments inside a thread."""
    segments, info = model.transcribe(
        file_path, language=language, initial_prompt=initial_prompt
    )
    return list(segments), info


class WhisperClient:
    """Async-friendly wrapper around the shared `faster_whisper.WhisperModel`.

    The model is loaded once at startup and shared by reference — the wrapper is cheap
    to instantiate (it just stores the reference). Sync inference is dispatched to a
    thread so FastAPI's event loop is not blocked.
    """

    def __init__(self, model: WhisperModel):
        self._model = model

    async def transcribe(
        self,
        wav_file_path: Path,
        *,
        language: str = "auto",
        initial_prompt: str | None = None,
    ) -> dict[str, Any]:
        """Transcribe a WAV file.

        Returns `{"text", "language", "segments"}` with post-processed text. The
        `"auto"` language sentinel maps to faster-whisper's `language=None` auto-detect.
        Raises `FileNotFoundError` if the WAV is missing and `WhisperTranscriptionError`
        for any in-process model error.
        """
        if not wav_file_path.exists():
            raise FileNotFoundError(f"WAV file not found: {wav_file_path}")

        effective_prompt = initial_prompt or _DEFAULT_PUNCTUATION_PROMPT
        model_language = None if language == "auto" else language

        try:
            segment_list, info = await asyncio.to_thread(
                _run_inference,
                self._model,
                str(wav_file_path),
                language=model_language,
                initial_prompt=effective_prompt,
            )
        except Exception as e:
            raise WhisperTranscriptionError(f"{e}") from e

        raw_text = "".join(seg.text for seg in segment_list).strip()
        detected_lang = info.language or detect_text_language(raw_text)
        joined = join_newline_segments(raw_text)
        normalized = normalize_punctuation(joined, detected_lang)

        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(
                "Transcription result:\n"
                "  prompt:     %r\n"
                "  raw:        %r\n"
                "  detected:   %s\n"
                "  joined:     %r\n"
                "  normalized: %r",
                effective_prompt,
                raw_text,
                detected_lang,
                joined,
                normalized,
            )

        return {
            "text": normalized,
            "language": detected_lang,
            "segments": [
                {"start": seg.start, "end": seg.end, "text": seg.text}
                for seg in segment_list
            ],
        }
