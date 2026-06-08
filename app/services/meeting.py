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

        Resolves the CT2 ASR model directory by delegating to the registry
        helper so the meeting endpoint reuses the same on-disk layout the
        rest of the server already knows about.
        """
        from app.services.registry import resolve_ct2_variant

        return cls(
            ct2_model_dir=resolve_ct2_variant(config.MEETING_MODEL_NAME),
            hf_token=config.HF_TOKEN or "",
            diarization_pipeline=config.MEETING_DIARIZATION_PIPELINE,
            align_model=config.MEETING_ALIGN_MODEL,
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

        import whisperx as _wx

        logger.info("Loading WhisperX ASR model from %s", self.ct2_model_dir)
        self._asr = await asyncio.to_thread(
            _wx.load_model,
            self.ct2_model_dir,
            device=self.device,
            compute_type=self.compute_type,
        )
        logger.info(
            "Loading pyannote diarization pipeline %s", self.diarization_pipeline_name
        )
        self._diarize = await asyncio.to_thread(
            Pipeline.from_pretrained,
            self.diarization_pipeline_name,
            token=self.hf_token,
        )
        self._loaded = True

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
            await self._load_pipeline()
            _report(progress_callback, "asr", 0.1)
            asr_out = await self._run_asr(audio_path, language=language)
            if enable_word_timestamps:
                _report(progress_callback, "align", 0.4)
                aligned = await self._run_align(asr_out, audio_path)
            else:
                aligned = asr_out
            _report(progress_callback, "diarize", 0.7)
            diarize_out = await self._run_diarize(
                audio_path,
                num_speakers=num_speakers,
                min_speakers=min_speakers,
                max_speakers=max_speakers,
            )
            result = self._merge(
                aligned, diarize_out, enable_word_timestamps=enable_word_timestamps
            )
            _report(progress_callback, "complete", 1.0)
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
