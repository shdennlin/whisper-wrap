"""Application configuration for the v2 in-process faster-whisper backend.

Dotenv loading is intentionally NOT triggered at import time. Entry points (main.py
and the test conftest) call `load_env_file()` explicitly so tests don't inherit
stale values from the developer's local `.env` file.

Env vars are read in `Config.__init__` (not as class attributes) so:
  - tests can construct fresh Config() instances after patching the environment
  - the module never needs to be reloaded
  - the module-level `config` singleton remains the single object every importer
    holds a reference to — monkey-patching its attributes is visible everywhere
"""

import logging
import os
from pathlib import Path

from dotenv import load_dotenv

logger = logging.getLogger(__name__)


def load_env_file(path: str = ".env") -> None:
    """Load environment variables from `.env`. Must be called by the entry point."""
    load_dotenv(path)


def _parse_bool(raw: str | None, *, default: bool, var_name: str = "") -> bool:
    """Parse a `"true"`/`"false"` env string with default fallback.

    None or empty string → silent default. Any other non-matching value logs a
    WARN naming `var_name` and falls back to default. Comparison is
    case-insensitive.
    """
    if raw is None or raw == "":
        return default
    lowered = raw.strip().lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    logger.warning(
        "Invalid value for %s=%r; using default %r",
        var_name or "(unknown)",
        raw,
        default,
    )
    return default


def _parse_int(raw: str | None, *, default: int, var_name: str = "") -> int:
    """Parse a non-negative integer env string with default fallback.

    None or empty string → silent default. Non-integer or negative value logs a
    WARN naming `var_name` and falls back to default.
    """
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning(
            "Invalid value for %s=%r; using default %r",
            var_name or "(unknown)",
            raw,
            default,
        )
        return default
    if value < 0:
        logger.warning(
            "Invalid value for %s=%r (must be non-negative); using default %r",
            var_name or "(unknown)",
            raw,
            default,
        )
        return default
    return value


def _parse_int_or_none(raw: str | None, *, var_name: str = "") -> int | None:
    """Parse a positive integer env string, returning None when unset.

    Distinct from `_parse_int(default=...)`: "no value" stays as None so
    downstream code can pass through to the library's own default (e.g.
    CTranslate2's internal cpu_threads heuristic) instead of being forced
    to invent a number.
    """
    if raw is None or raw == "":
        return None
    try:
        value = int(raw)
    except ValueError:
        logger.warning(
            "Invalid value for %s=%r; ignoring",
            var_name or "(unknown)",
            raw,
        )
        return None
    if value <= 0:
        logger.warning(
            "Invalid value for %s=%r (must be positive); ignoring",
            var_name or "(unknown)",
            raw,
        )
        return None
    return value


class Config:
    """Application configuration loaded from environment variables at construction time."""

    def __init__(self) -> None:
        # Server
        self.API_PORT: int = int(os.getenv("API_PORT", "8000"))
        self.API_HOST: str = os.getenv("API_HOST", "0.0.0.0")

        # Model resolution. MODEL_DIR (if set) overrides MODEL_NAME registry lookup.
        self.MODEL_NAME: str = os.getenv("MODEL_NAME", "breeze-asr-25")
        self.MODEL_DIR: str | None = os.environ.get("MODEL_DIR") or None

        # CTranslate2 runtime hints. COMPUTE_TYPE="default" lets CT2 pick the runtime
        # path; required on Apple Silicon CPU because int8_float16 storage does not
        # map 1:1 to a CPU compute path.
        self.COMPUTE_TYPE: str = os.getenv("COMPUTE_TYPE", "default")
        self.DEVICE: str = os.getenv("DEVICE", "auto")
        # CT2 worker thread count. None → CT2's default (4). Apple Silicon
        # M2 (10 cores: 4P + 6E) typically benefits from bumping to 6-8 so
        # the matmul kernels saturate P-cores; faster-whisper does NOT
        # auto-detect. Applied to both /transcribe and /transcribe/meeting
        # CT2 backends.
        self.CPU_THREADS: int | None = _parse_int_or_none(
            os.getenv("CPU_THREADS"), var_name="CPU_THREADS"
        )

        # v2.1 backend override. When set ("ct2" | "ggml"), the lifespan SHALL pick
        # the matching variant of the active model. When unset, platform-based
        # `default_on` resolves the variant.
        self.BACKEND_FORMAT: str | None = os.environ.get("BACKEND_FORMAT") or None

        # v2.2 VAD selector. When set ("silero" | "rms"), the lifespan opts in
        # explicitly. When unset, lifespan tries silero-vad first and falls
        # back to rms with one INFO log line if import fails.
        self.VAD_BACKEND: str | None = os.environ.get("VAD_BACKEND") or None

        # LLM (Gemini for /ask). Preserve unset (None) vs empty ("") so llm.py can
        # implement the spec's "unset = silent default, empty = warn + default" policy.
        self.GEMINI_API_KEY: str | None = os.environ.get("GEMINI_API_KEY")
        self.GEMINI_MODEL: str | None = os.environ.get("GEMINI_MODEL")
        self.GEMINI_SYSTEM_PROMPT: str | None = os.environ.get("GEMINI_SYSTEM_PROMPT")

        # Meeting analysis (POST /transcribe/meeting). Gated at endpoint level —
        # missing HF_TOKEN does NOT block lifespan. HF_TOKEN preserves unset (None)
        # vs empty ("") so the endpoint can translate either to a 503 without
        # losing the distinction. MEETING_MODEL_NAME falls back to MODEL_NAME when
        # unset or empty.
        self.HF_TOKEN: str | None = os.environ.get("HF_TOKEN")
        self.MEETING_MODEL_NAME: str = (
            os.environ.get("MEETING_MODEL_NAME") or self.MODEL_NAME
        )
        self.MEETING_JOB_TTL_SECONDS: int = _parse_int(
            os.getenv("MEETING_JOB_TTL_SECONDS"),
            default=3600,
            var_name="MEETING_JOB_TTL_SECONDS",
        )
        self.MEETING_MAX_JOBS: int = _parse_int(
            os.getenv("MEETING_MAX_JOBS"),
            default=20,
            var_name="MEETING_MAX_JOBS",
        )
        self.MEETING_DIARIZATION_PIPELINE: str = os.getenv(
            "MEETING_DIARIZATION_PIPELINE", "pyannote/speaker-diarization-3.1"
        )
        # None lets WhisperX pick a per-language default at load time.
        self.MEETING_ALIGN_MODEL: str | None = (
            os.environ.get("MEETING_ALIGN_MODEL") or None
        )
        # WhisperX ASR batch size. Higher = better CPU SIMD utilisation on
        # long files; trade-off is RAM (~150-250 MB per batch slot for
        # whisper-large). Default 32 matches whisperx's documented sweet
        # spot for batched inference and gives ~10-15% speedup over the
        # built-in default of 16 on Apple Silicon CPU. Unset → 32.
        self.MEETING_BATCH_SIZE: int = _parse_int(
            os.getenv("MEETING_BATCH_SIZE"),
            default=32,
            var_name="MEETING_BATCH_SIZE",
        )
        # Torch device for the align (wav2vec2) + diarize (pyannote) stages
        # of the meeting pipeline. CTranslate2 ASR stays on CPU regardless
        # because ct2 has no MPS/Metal backend. Values:
        #   "auto" — try MPS on macOS, CUDA on Linux, else CPU (default)
        #   "mps"  — force Apple Metal Performance Shaders
        #   "cuda" — force CUDA
        #   "cpu"  — force CPU
        # On Apple Silicon, MPS typically cuts the align + diarize stages
        # by 4-8x for long-form audio.
        self.MEETING_TORCH_DEVICE: str = (
            os.environ.get("MEETING_TORCH_DEVICE") or "auto"
        )

        # File handling
        self.MAX_FILE_SIZE_MB: int = int(os.getenv("MAX_FILE_SIZE_MB", "100"))
        self.TEMP_DIR: Path = Path(os.getenv("TEMP_DIR", "/tmp/whisper-wrap"))
        self.UPLOAD_TIMEOUT_SECONDS: int = int(
            os.getenv("UPLOAD_TIMEOUT_SECONDS", "30")
        )

        # Logging
        self.LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")

        # v2.3 persistence. data_dir holds the SQLite db + audio blobs; both
        # paths are created by lifespan before alembic upgrade runs. The
        # database_url default is derived from data_dir at read time but env
        # `DATABASE_URL` wins outright so tests can point at `:memory:`.
        self.DATA_DIR: Path = Path(os.getenv("DATA_DIR", "data"))
        self.DATABASE_URL: str = os.getenv(
            "DATABASE_URL", f"sqlite:///{self.DATA_DIR}/history.db"
        )

        # Transcription empty-filter (single source of truth for noise rejection
        # across /listen, /transcribe, /ask, /v1/audio/transcriptions).
        # Defaults-on; invalid env values log WARN + fall back to defaults.
        self.FILTER_EMPTY_ENABLED: bool = _parse_bool(
            os.getenv("FILTER_EMPTY_ENABLED"),
            default=True,
            var_name="FILTER_EMPTY_ENABLED",
        )
        self.FILTER_MIN_DURATION_MS: int = _parse_int(
            os.getenv("FILTER_MIN_DURATION_MS"),
            default=500,
            var_name="FILTER_MIN_DURATION_MS",
        )

    @property
    def audio_dir(self) -> Path:
        return self.DATA_DIR / "audio"

    @property
    def max_file_size_bytes(self) -> int:
        return self.MAX_FILE_SIZE_MB * 1024 * 1024

    def ensure_temp_dir(self) -> None:
        self.TEMP_DIR.mkdir(parents=True, exist_ok=True)

    def ensure_data_dirs(self) -> None:
        self.DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.audio_dir.mkdir(parents=True, exist_ok=True)

    def validate_port(self) -> None:
        if not (1 <= self.API_PORT <= 65535):
            raise ValueError(
                f"Invalid API_PORT: {self.API_PORT}. Must be between 1-65535."
            )


config = Config()
