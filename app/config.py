import os
from pathlib import Path

from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()


class Config:
    """Application configuration loaded from environment variables."""

    # Server port configuration
    API_PORT: int = int(os.getenv("API_PORT", "8000"))
    API_HOST: str = os.getenv("API_HOST", "0.0.0.0")
    
    # Whisper server configuration
    WHISPER_SERVER_URL: str = os.getenv("WHISPER_SERVER_URL", "http://localhost:9000")
    WHISPER_SERVER_PORT: int = int(os.getenv("WHISPER_SERVER_PORT", "9000"))
    WHISPER_SERVER_HOST: str = os.getenv("WHISPER_SERVER_HOST", "localhost")

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

    @property
    def whisper_server_url(self) -> str:
        """Get dynamically constructed whisper server URL if individual components are provided."""
        # If WHISPER_SERVER_URL is explicitly set, use it
        if os.getenv("WHISPER_SERVER_URL"):
            return self.WHISPER_SERVER_URL
        # Otherwise, construct from host and port
        return f"http://{self.WHISPER_SERVER_HOST}:{self.WHISPER_SERVER_PORT}"

    def ensure_temp_dir(self) -> None:
        """Ensure temporary directory exists."""
        self.TEMP_DIR.mkdir(parents=True, exist_ok=True)

    def validate_ports(self) -> None:
        """Validate port configuration."""
        def is_valid_port(port: int) -> bool:
            return 1 <= port <= 65535

        if not is_valid_port(self.API_PORT):
            raise ValueError(f"Invalid API_PORT: {self.API_PORT}. Must be between 1-65535.")
        
        if not is_valid_port(self.WHISPER_SERVER_PORT):
            raise ValueError(f"Invalid WHISPER_SERVER_PORT: {self.WHISPER_SERVER_PORT}. Must be between 1-65535.")
        
        if self.API_PORT == self.WHISPER_SERVER_PORT and self.API_HOST == self.WHISPER_SERVER_HOST:
            raise ValueError(f"API_PORT and WHISPER_SERVER_PORT cannot be the same when running on the same host.")


# Global configuration instance
config = Config()
