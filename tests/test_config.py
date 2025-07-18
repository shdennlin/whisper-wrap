import tempfile
from pathlib import Path

from app.config import Config


def test_config_defaults():
    """Test default configuration values."""
    config = Config()

    assert config.WHISPER_SERVER_URL == "http://localhost:9000"
    assert config.MAX_FILE_SIZE_MB == 100
    assert config.LOG_LEVEL == "INFO"
    assert config.UPLOAD_TIMEOUT_SECONDS == 30


def test_config_from_env(monkeypatch):
    """Test configuration from environment variables."""
    # Clear any existing .env file effect by reloading
    monkeypatch.setenv("WHISPER_SERVER_URL", "http://test:8888")
    monkeypatch.setenv("MAX_FILE_SIZE_MB", "50")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")

    # Import after setting env vars to ensure they're picked up
    import importlib

    from app import config as config_module

    importlib.reload(config_module)
    test_config = config_module.Config()

    assert test_config.WHISPER_SERVER_URL == "http://test:8888"
    assert test_config.MAX_FILE_SIZE_MB == 50
    assert test_config.LOG_LEVEL == "DEBUG"


def test_max_file_size_bytes():
    """Test file size conversion."""
    config = Config()
    config.MAX_FILE_SIZE_MB = 10

    assert config.max_file_size_bytes == 10 * 1024 * 1024


def test_ensure_temp_dir():
    """Test temporary directory creation."""
    with tempfile.TemporaryDirectory() as temp_dir:
        test_dir = Path(temp_dir) / "test_whisper"
        config = Config()
        config.TEMP_DIR = test_dir

        assert not test_dir.exists()
        config.ensure_temp_dir()
        assert test_dir.exists()
