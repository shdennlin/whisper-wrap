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
        cpu_threads: int | None = None,
        batch_size: int = 32,
        torch_device: str = "cpu",
    ) -> None:
        self.ct2_model_dir = ct2_model_dir
        self.hf_token = hf_token
        self.diarization_pipeline_name = diarization_pipeline
        self.align_model_name = align_model
        # CT2 device — "cpu" or "cuda" only. ct2 has no MPS backend so on
        # Apple Silicon this stays "cpu" regardless of torch_device.
        self.device = device
        self.compute_type = compute_type
        self.cpu_threads = cpu_threads
        # ASR batched-inference width. Pushed into the FasterWhisperPipeline
        # at transcribe() time (NOT at load_model() — whisperx takes it per
        # call, not per model).
        self.batch_size = batch_size
        # Torch device for align + diarize stages. Decoupled from CT2's
        # `device` because pyannote / wav2vec2 are torch-native and CAN use
        # MPS on Apple Silicon, while ct2 cannot. Resolved by from_config().
        self.torch_device = torch_device
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

        # Resolve torch device for align + diarize stages. "auto" tries the
        # fastest available accelerator. We import torch lazily INSIDE this
        # block so configs that never touch the meeting endpoint don't pay
        # the torch import cost.
        configured_td = (getattr(config, "MEETING_TORCH_DEVICE", "auto") or "auto").lower()
        torch_device = _resolve_torch_device(configured_td)

        return cls(
            ct2_model_dir=str(DEFAULT_MODELS_ROOT / variant["local_dir"]),
            hf_token=config.HF_TOKEN or "",
            diarization_pipeline=config.MEETING_DIARIZATION_PIPELINE,
            align_model=config.MEETING_ALIGN_MODEL,
            compute_type=compute_type,
            cpu_threads=getattr(config, "CPU_THREADS", None),
            batch_size=getattr(config, "MEETING_BATCH_SIZE", 32),
            torch_device=torch_device,
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
            "Loading WhisperX ASR model from %s (compute_type=%s, device=%s, cpu_threads=%s)",
            self.ct2_model_dir,
            self.compute_type,
            self.device,
            self.cpu_threads if self.cpu_threads is not None else "default",
        )
        asr_load_start = _time.monotonic()
        # WhisperX forwards extra kwargs to faster-whisper's WhisperModel.
        # cpu_threads is a real WhisperModel parameter; only pass it when
        # set so we don't override CT2's heuristic when the user hasn't
        # opted in.
        load_kwargs: dict[str, Any] = {
            "device": self.device,
            "compute_type": self.compute_type,
        }
        if self.cpu_threads is not None:
            load_kwargs["threads"] = self.cpu_threads
        self._asr = await asyncio.to_thread(
            _wx.load_model,
            self.ct2_model_dir,
            **load_kwargs,
        )
        logger.info(
            "Loaded WhisperX ASR model in %.1fs",
            _time.monotonic() - asr_load_start,
        )
        logger.info(
            "Loading pyannote diarization pipeline %s (torch_device=%s)",
            self.diarization_pipeline_name,
            self.torch_device,
        )
        diar_load_start = _time.monotonic()
        self._diarize = await asyncio.to_thread(
            Pipeline.from_pretrained,
            self.diarization_pipeline_name,
            token=self.hf_token,
        )
        # Move the diarize pipeline to the configured torch device. pyannote
        # supports MPS on Apple Silicon since 3.0 — for long-form audio this
        # cuts the embedding-extraction stage by ~5-10x because the
        # wav2vec2-style backbone gets to run on the Metal GPU. We use a
        # try/except because some pyannote internals (e.g. PLDA scoring)
        # have ops that fall back to CPU on MPS, and a hard failure here
        # would block the entire pipeline.
        if self.torch_device != "cpu":
            import torch

            try:
                await asyncio.to_thread(self._diarize.to, torch.device(self.torch_device))
                logger.info(
                    "Moved pyannote pipeline to %s for accelerated inference",
                    self.torch_device,
                )
            except Exception as e:  # noqa: BLE001 — broad to keep startup resilient
                logger.warning(
                    "Failed to move pyannote pipeline to %s (%s); diarize will run on cpu",
                    self.torch_device,
                    e,
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

    async def analyze_with_external_asr(
        self,
        audio_path: str,
        *,
        asr_segments: list[dict[str, Any]],
        language: str,
        num_speakers: int | None = None,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
        enable_word_timestamps: bool = True,
        progress_callback: ProgressCallback | None = None,
    ) -> MeetingResult:
        """Run align + diarize + merge given pre-computed ASR segments.

        Fast-mode entry point. Caller (the meeting endpoint) is expected to
        have produced `asr_segments` by calling the platform-default
        `WhisperBackend.transcribe()` — pywhispercpp+ggml+ANE on macOS,
        ct2 with CUDA on Linux. By skipping `_run_asr`, this method cuts
        a 2h15min file's runtime on Apple Silicon from ~35-45 min to
        ~5-10 min (the align+diarize stages run on MPS thanks to the
        previous `503cc0f` perf commit).

        Shape contract for `asr_segments`: each dict has at least
        `"start"`, `"end"`, `"text"`. WhisperX's downstream stages
        consume only those three keys (`meeting.py:_run_align` /
        `_merge`); extra fields are accepted and ignored.

        Reuses `_run_align`, `_run_diarize`, `_merge` unchanged so the
        result is byte-for-byte identical with the slow-path output for
        the same effective transcript — only the ASR backend swapped.
        """
        async with self._lock:
            import time as _time

            pipeline_start = _time.monotonic()
            await self._load_pipeline()

            # The "asr_external" stage label distinguishes this path from
            # the WhisperX ASR stage in log scrapers and progress UI.
            _report(progress_callback, "asr_external", 0.1)
            logger.info(
                "Meeting stage=asr_external (using external segments, %d items)",
                len(asr_segments),
            )

            asr_out: dict[str, Any] = {
                "language": language,
                "segments": asr_segments,
            }

            align_elapsed = 0.0
            if enable_word_timestamps:
                _report(progress_callback, "align", 0.4)
                align_start = _time.monotonic()
                logger.info("Meeting stage=align start (fast path)")
                aligned = await self._run_align(asr_out, audio_path)
                align_elapsed = _time.monotonic() - align_start
                logger.info(
                    "Meeting stage=align done elapsed=%.1fs", align_elapsed
                )
            else:
                logger.info(
                    "Meeting stage=align skipped (word_timestamps=false)"
                )
                aligned = asr_out

            _report(progress_callback, "diarize", 0.7)
            diar_start = _time.monotonic()
            logger.info("Meeting stage=diarize start (fast path)")
            diarize_out = await self._run_diarize(
                audio_path,
                num_speakers=num_speakers,
                min_speakers=min_speakers,
                max_speakers=max_speakers,
            )
            diar_elapsed = _time.monotonic() - diar_start
            logger.info(
                "Meeting stage=diarize done elapsed=%.1fs", diar_elapsed
            )

            result = self._merge(
                aligned,
                diarize_out,
                enable_word_timestamps=enable_word_timestamps,
            )
            _report(progress_callback, "complete", 1.0)
            total = _time.monotonic() - pipeline_start
            logger.info(
                "Meeting pipeline complete (fast) total=%.1fs"
                " (align=%.1fs diarize=%.1fs)",
                total,
                align_elapsed,
                diar_elapsed,
            )
            return result

    async def _run_asr(
        self, audio_path: str, *, language: str | None
    ) -> dict[str, Any]:
        import whisperx as _wx

        audio = await asyncio.to_thread(_wx.load_audio, audio_path)
        # batch_size is the WhisperX-specific knob — higher = better CPU
        # SIMD saturation on long files. Memory cost ~150-250 MB per slot
        # on whisper-large; 32 is the documented sweet spot.
        return await asyncio.to_thread(
            self._asr.transcribe,
            audio,
            language=language,
            batch_size=self.batch_size,
        )

    async def _run_align(
        self, asr_out: dict[str, Any], audio_path: str
    ) -> dict[str, Any]:
        import whisperx as _wx

        # Align uses the torch-native wav2vec2 path, so it CAN take MPS
        # while the ct2 ASR upstream stays CPU-bound. self.torch_device is
        # the resolved device for the align + diarize stages.
        language = asr_out["language"]
        model_a, metadata = await asyncio.to_thread(
            _wx.load_align_model,
            language_code=language,
            device=self.torch_device,
            model_name=self.align_model_name,
        )
        audio = await asyncio.to_thread(_wx.load_audio, audio_path)
        return await asyncio.to_thread(
            _wx.align,
            asr_out["segments"],
            model_a,
            metadata,
            audio,
            self.torch_device,
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


def _resolve_torch_device(configured: str) -> str:
    """Map MEETING_TORCH_DEVICE config to a usable torch device string.

    Imports torch lazily to keep the meeting extras truly optional. Caller
    is responsible for catching ImportError elsewhere in the load path —
    `from_config` only runs when the endpoint is gated open, which already
    requires the optional [meeting] extras group.

    "auto" resolution: MPS on macOS if available, CUDA on Linux, else CPU.
    Forced values fall back to CPU with a WARN log if the requested device
    isn't available (instead of crashing at first transcribe).
    """
    import sys

    try:
        import torch
    except ImportError:
        return "cpu"

    if configured == "auto":
        if sys.platform == "darwin" and torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"
    if configured == "mps":
        if torch.backends.mps.is_available():
            return "mps"
        logger.warning(
            "MEETING_TORCH_DEVICE=mps requested but MPS not available "
            "(needs macOS + Apple Silicon + torch built with mps); falling back to cpu"
        )
        return "cpu"
    if configured == "cuda":
        if torch.cuda.is_available():
            return "cuda"
        logger.warning(
            "MEETING_TORCH_DEVICE=cuda requested but CUDA not available; "
            "falling back to cpu"
        )
        return "cpu"
    return "cpu"
