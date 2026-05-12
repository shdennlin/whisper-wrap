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


OBSOLETE_V1_KEYS: tuple[str, ...] = (
    "WHISPER_SERVER_HOST",
    "WHISPER_SERVER_PORT",
    "WHISPER_SERVER_URL",
    "WHISPER_AUTO_RESTART",
    "WHISPER_BINARY_PATH",
    "WHISPER_MAX_RETRIES",
    "MODEL_PATH",
)


def load_env_file(path: str = ".env") -> None:
    """Load environment variables from `.env`. Must be called by the entry point."""
    load_dotenv(path)


def warn_obsolete_env_vars() -> list[str]:
    """Emit a WARNING for each v1 env var still present in the environment."""
    detected: list[str] = []
    for key in OBSOLETE_V1_KEYS:
        if key in os.environ:
            logger.warning(
                "Obsolete v1 env var %s detected — ignored in v2 (see CHANGELOG for migration)",
                key,
            )
            detected.append(key)
    return detected


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

        # LLM (Gemini for /ask). Preserve unset (None) vs empty ("") so llm.py can
        # implement the spec's "unset = silent default, empty = warn + default" policy.
        self.GEMINI_API_KEY: str | None = os.environ.get("GEMINI_API_KEY")
        self.GEMINI_MODEL: str | None = os.environ.get("GEMINI_MODEL")
        self.GEMINI_SYSTEM_PROMPT: str | None = os.environ.get("GEMINI_SYSTEM_PROMPT")

        # File handling
        self.MAX_FILE_SIZE_MB: int = int(os.getenv("MAX_FILE_SIZE_MB", "100"))
        self.TEMP_DIR: Path = Path(os.getenv("TEMP_DIR", "/tmp/whisper-wrap"))
        self.UPLOAD_TIMEOUT_SECONDS: int = int(os.getenv("UPLOAD_TIMEOUT_SECONDS", "30"))

        # Logging
        self.LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")

    @property
    def max_file_size_bytes(self) -> int:
        return self.MAX_FILE_SIZE_MB * 1024 * 1024

    def ensure_temp_dir(self) -> None:
        self.TEMP_DIR.mkdir(parents=True, exist_ok=True)

    def validate_port(self) -> None:
        if not (1 <= self.API_PORT <= 65535):
            raise ValueError(
                f"Invalid API_PORT: {self.API_PORT}. Must be between 1-65535."
            )


config = Config()
