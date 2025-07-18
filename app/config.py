import os
from pathlib import Path

from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()


class Config:
    """Application configuration loaded from environment variables."""

    # Whisper server configuration
    WHISPER_SERVER_URL: str = os.getenv("WHISPER_SERVER_URL", "http://localhost:9000")

    # File handling configuration
    MAX_FILE_SIZE_MB: int = int(os.getenv("MAX_FILE_SIZE_MB", "100"))
    TEMP_DIR: Path = Path(os.getenv("TEMP_DIR", "/tmp/whisper-wrap"))
    UPLOAD_TIMEOUT_SECONDS: int = int(os.getenv("UPLOAD_TIMEOUT_SECONDS", "30"))

    # Logging configuration
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "DEBUG")

    @property
    def max_file_size_bytes(self) -> int:
        """Convert MB to bytes for file size validation."""
        return self.MAX_FILE_SIZE_MB * 1024 * 1024

    def ensure_temp_dir(self) -> None:
        """Ensure temporary directory exists."""
        self.TEMP_DIR.mkdir(parents=True, exist_ok=True)


# Global configuration instance
config = Config()
