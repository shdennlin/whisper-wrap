"""Meeting analysis pipeline backed by WhisperX + pyannote.

This module is intentionally separate from `app/services/_whisper_backend.py`
and its implementations. The `WhisperBackend` Protocol returns segment-level
results without speakers or word timestamps; the meeting workflow needs both,
plus a different model lifecycle (lazy load, multiple sub-models). Keeping it
isolated prevents accidental coupling to the /transcribe / /listen / /ask
hot paths.

Heavy imports (`whisperx`, `pyannote.audio`, `torch`) happen lazily inside
`_load_pipeline()` so that:
  - server startup is unaffected when the meeting endpoint is never called
  - servers without the optional `[meeting]` extras still start normally
  - tests can monkeypatch the per-stage methods without dragging the deps in
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class Word:
    word: str
    start: float
    end: float


@dataclass
class Segment:
    speaker: str
    start: float
    end: float
    text: str
    words: list[Word] | None = None


@dataclass
class MeetingResult:
    language: str
    duration_seconds: float
    speakers: list[str]
    segments: list[Segment] = field(default_factory=list)


class MeetingAnalysisError(RuntimeError):
    """Base error for any failure inside the meeting pipeline."""


class MeetingExtrasMissingError(MeetingAnalysisError):
    """Raised when `whisperx` or `pyannote.audio` cannot be imported. The
    endpoint translates this to a 503 with reason `meeting extras not installed`."""


ProgressCallback = Callable[[str, float], None]


class MeetingAnalyzer:
    """WhisperX-backed meeting analysis pipeline (ASR + align + diarize).

    The constructor records configuration but does NOT load any models — the
    first call to `analyze()` triggers `_load_pipeline()`. After loading the
    pipeline stays resident for the lifetime of the process.

    Concurrency: a single `asyncio.Lock` serialises calls so only one analysis
    runs at a time per process. Whisper + pyannote are CPU-bound; running two
    in parallel would just double memory and halve throughput.
    """

    def __init__(
        self,
        *,
        ct2_model_dir: str,
        hf_token: str,
        diarization_pipeline: str,
        align_model: str | None = None,
        device: str = "cpu",
        compute_type: str = "default",
    ) -> None:
        self.ct2_model_dir = ct2_model_dir
        self.hf_token = hf_token
        self.diarization_pipeline_name = diarization_pipeline
        self.align_model_name = align_model
        self.device = device
        self.compute_type = compute_type
        self._asr: Any = None
        self._diarize: Any = None
        self._lock = asyncio.Lock()
        self._loaded = False

    @property
    def loaded(self) -> bool:
        return self._loaded

    @classmethod
    def from_config(cls, config: Any) -> MeetingAnalyzer:
        """Construct an analyzer from a populated `app.config.Config` instance.

        Resolves the CT2 ASR model directory AND its registry-declared
        compute_type so WhisperX runs at the quantisation the variant was
        compiled for (e.g. int8_float16 on CUDA). Without this, WhisperX
        falls back to float32 — 3-5x slower than the int8 path on CPU.

        Platform adjustment: registry variants target their primary backend
        (typically CUDA), but the meeting endpoint also runs on macOS / CPU
        where int8_float16 is not supported (CTranslate2 raises ValueError
        because CPU lacks float16 SIMD). On CPU we map int8_float16 →
        int8, which is supported and gives the same ~3x speedup over
        float32 without needing a separate registry entry.
        """
        import sys

        from app.services.registry import (
            DEFAULT_MODELS_ROOT,
            resolve_ct2_variant_info,
        )

        variant = resolve_ct2_variant_info(config.MEETING_MODEL_NAME)
        compute_type = variant.get("compute_type") or "default"
        # Apple Silicon CPU doesn't have the float16 SIMD path CTranslate2
        # needs for int8_float16. int8 is the supported equivalent.
        if compute_type == "int8_float16" and sys.platform == "darwin":
            compute_type = "int8"
        return cls(
            ct2_model_dir=str(DEFAULT_MODELS_ROOT / variant["local_dir"]),
            hf_token=config.HF_TOKEN or "",
            diarization_pipeline=config.MEETING_DIARIZATION_PIPELINE,
            align_model=config.MEETING_ALIGN_MODEL,
            compute_type=compute_type,
        )

    async def _load_pipeline(self) -> None:
        """Import and instantiate the WhisperX ASR model and the pyannote
        diarization pipeline. Alignment models are loaded per language on
        demand inside `_run_align`.
        """
        if self._loaded:
            return
        try:
            import whisperx  # noqa: F401
            from pyannote.audio import Pipeline
        except ImportError as e:
            raise MeetingExtrasMissingError("meeting extras not installed") from e

        import time as _time

        import whisperx as _wx

        load_start = _time.monotonic()
        logger.info(
            "Loading WhisperX ASR model from %s (compute_type=%s, device=%s)",
            self.ct2_model_dir,
            self.compute_type,
            self.device,
        )
        asr_load_start = _time.monotonic()
        self._asr = await asyncio.to_thread(
            _wx.load_model,
            self.ct2_model_dir,
            device=self.device,
            compute_type=self.compute_type,
        )
        logger.info(
            "Loaded WhisperX ASR model in %.1fs",
            _time.monotonic() - asr_load_start,
        )
        logger.info(
            "Loading pyannote diarization pipeline %s", self.diarization_pipeline_name
        )
        diar_load_start = _time.monotonic()
        self._diarize = await asyncio.to_thread(
            Pipeline.from_pretrained,
            self.diarization_pipeline_name,
            token=self.hf_token,
        )
        logger.info(
            "Loaded pyannote pipeline in %.1fs",
            _time.monotonic() - diar_load_start,
        )
        self._loaded = True
        logger.info(
            "Meeting pipeline ready (total load %.1fs)",
            _time.monotonic() - load_start,
        )

    async def analyze(
        self,
        audio_path: str,
        *,
        language: str | None = None,
        num_speakers: int | None = None,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
        enable_word_timestamps: bool = True,
        progress_callback: ProgressCallback | None = None,
    ) -> MeetingResult:
        async with self._lock:
            # Per-stage timing log. Uses time.monotonic() so wall-clock
            # adjustments don't skew the elapsed numbers. Same lines also
            # double as the canonical "how long did each stage take" record
            # that future regressions can be compared against.
            import time as _time

            pipeline_start = _time.monotonic()
            await self._load_pipeline()

            _report(progress_callback, "asr", 0.1)
            asr_start = _time.monotonic()
            logger.info("Meeting stage=asr start")
            asr_out = await self._run_asr(audio_path, language=language)
            asr_elapsed = _time.monotonic() - asr_start
            logger.info("Meeting stage=asr done elapsed=%.1fs", asr_elapsed)

            align_elapsed = 0.0
            if enable_word_timestamps:
                _report(progress_callback, "align", 0.4)
                align_start = _time.monotonic()
                logger.info("Meeting stage=align start")
                aligned = await self._run_align(asr_out, audio_path)
                align_elapsed = _time.monotonic() - align_start
                logger.info("Meeting stage=align done elapsed=%.1fs", align_elapsed)
            else:
                logger.info("Meeting stage=align skipped (word_timestamps=false)")
                aligned = asr_out

            _report(progress_callback, "diarize", 0.7)
            diar_start = _time.monotonic()
            logger.info("Meeting stage=diarize start")
            diarize_out = await self._run_diarize(
                audio_path,
                num_speakers=num_speakers,
                min_speakers=min_speakers,
                max_speakers=max_speakers,
            )
            diar_elapsed = _time.monotonic() - diar_start
            logger.info("Meeting stage=diarize done elapsed=%.1fs", diar_elapsed)

            result = self._merge(
                aligned, diarize_out, enable_word_timestamps=enable_word_timestamps
            )
            _report(progress_callback, "complete", 1.0)
            total = _time.monotonic() - pipeline_start
            logger.info(
                "Meeting pipeline complete total=%.1fs"
                " (asr=%.1fs align=%.1fs diarize=%.1fs)",
                total,
                asr_elapsed,
                align_elapsed,
                diar_elapsed,
            )
            return result

    async def _run_asr(
        self, audio_path: str, *, language: str | None
    ) -> dict[str, Any]:
        import whisperx as _wx

        audio = await asyncio.to_thread(_wx.load_audio, audio_path)
        return await asyncio.to_thread(self._asr.transcribe, audio, language=language)

    async def _run_align(
        self, asr_out: dict[str, Any], audio_path: str
    ) -> dict[str, Any]:
        import whisperx as _wx

        language = asr_out["language"]
        model_a, metadata = await asyncio.to_thread(
            _wx.load_align_model,
            language_code=language,
            device=self.device,
            model_name=self.align_model_name,
        )
        audio = await asyncio.to_thread(_wx.load_audio, audio_path)
        return await asyncio.to_thread(
            _wx.align,
            asr_out["segments"],
            model_a,
            metadata,
            audio,
            self.device,
            return_char_alignments=False,
        )

    async def _run_diarize(
        self,
        audio_path: str,
        *,
        num_speakers: int | None,
        min_speakers: int | None,
        max_speakers: int | None,
    ) -> Any:
        kwargs: dict[str, Any] = {}
        if num_speakers is not None:
            kwargs["num_speakers"] = num_speakers
        if min_speakers is not None:
            kwargs["min_speakers"] = min_speakers
        if max_speakers is not None:
            kwargs["max_speakers"] = max_speakers
        return await asyncio.to_thread(self._diarize, audio_path, **kwargs)

    def _merge(
        self,
        aligned: dict[str, Any],
        diarize_out: Any,
        *,
        enable_word_timestamps: bool,
    ) -> MeetingResult:
        import whisperx as _wx

        merged = _wx.assign_word_speakers(diarize_out, aligned)
        segments: list[Segment] = []
        speaker_order: list[str] = []
        seen: set[str] = set()
        for seg in merged.get("segments", []):
            speaker = seg.get("speaker", "SPEAKER_UNKNOWN")
            if speaker not in seen:
                seen.add(speaker)
                speaker_order.append(speaker)
            words: list[Word] | None = None
            if enable_word_timestamps and "words" in seg:
                words = [
                    Word(
                        word=w["word"],
                        start=float(w["start"]),
                        end=float(w["end"]),
                    )
                    for w in seg["words"]
                    if "start" in w and "end" in w
                ]
            segments.append(
                Segment(
                    speaker=speaker,
                    start=float(seg["start"]),
                    end=float(seg["end"]),
                    text=seg["text"].strip(),
                    words=words,
                )
            )
        language = aligned.get("language") or merged.get("language") or "und"
        duration = max((s.end for s in segments), default=0.0)
        return MeetingResult(
            language=language,
            duration_seconds=duration,
            speakers=speaker_order,
            segments=segments,
        )


def _report(cb: ProgressCallback | None, stage: str, progress: float) -> None:
    if cb is not None:
        cb(stage, progress)
