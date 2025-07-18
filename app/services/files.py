import logging
import uuid
from pathlib import Path

import magic

from app.config import config

logger = logging.getLogger(__name__)


class FileManager:
    """Handles temporary file creation, validation, and cleanup."""

    def __init__(self):
        config.ensure_temp_dir()

    def create_temp_file(self, suffix: str = "") -> Path:
        """Create a temporary file with automatic cleanup tracking."""
        temp_file = config.TEMP_DIR / f"{uuid.uuid4()}{suffix}"
        return temp_file

    def validate_file_size(self, file_path: Path) -> bool:
        """Validate file size against configured limits."""
        file_size = file_path.stat().st_size
        return file_size <= config.max_file_size_bytes

    def detect_mime_type(self, file_path: Path) -> str:
        """Detect MIME type of the file."""
        mime = magic.Magic(mime=True)
        return mime.from_file(str(file_path))

    def is_audio_file(self, file_path: Path) -> bool:
        """Check if file is a supported audio/video format."""
        mime_type = self.detect_mime_type(file_path)

        supported_audio = {
            "audio/mpeg",  # mp3
            "audio/wav",  # wav
            "audio/x-wav",  # wav
            "audio/flac",  # flac
            "audio/ogg",  # ogg
            "audio/aac",  # aac
            "audio/mp4",  # m4a
            "audio/x-ms-wma",  # wma
            "audio/mp4a-latm",  # m4a alternative
            "audio/x-m4a",  # m4a alternative
        }

        supported_video = {
            "video/mp4",  # mp4
            "video/avi",  # avi
            "video/quicktime",  # mov
            "video/x-msvideo",  # avi
            "video/x-matroska",  # mkv
        }

        is_supported = mime_type in supported_audio or mime_type in supported_video

        logger.debug(f"MIME type check: {mime_type} -> supported: {is_supported}")
        logger.debug(f"Supported audio types: {supported_audio}")
        logger.debug(f"Supported video types: {supported_video}")

        return is_supported

    def cleanup_file(self, file_path: Path) -> None:
        """Remove temporary file safely."""
        try:
            if file_path.exists():
                file_path.unlink()
        except OSError:
            pass  # File might already be deleted or not accessible


file_manager = FileManager()
