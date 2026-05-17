"""Tests for v2 Config (in-process faster-whisper backend)."""

import logging

import pytest

from app.config import Config

OBSOLETE_V1_KEYS = (
    "WHISPER_SERVER_HOST",
    "WHISPER_SERVER_PORT",
    "WHISPER_SERVER_URL",
    "WHISPER_AUTO_RESTART",
    "WHISPER_BINARY_PATH",
    "WHISPER_MAX_RETRIES",
    "MODEL_PATH",
)


@pytest.fixture
def clean_env(monkeypatch):
    """Strip every env var Config reads so default-resolution tests are deterministic
    regardless of the developer's local shell or .env."""
    for k in (
        *OBSOLETE_V1_KEYS,
        "API_PORT",
        "API_HOST",
        "MODEL_NAME",
        "MODEL_DIR",
        "COMPUTE_TYPE",
        "DEVICE",
        "GEMINI_API_KEY",
        "GEMINI_MODEL",
        "GEMINI_SYSTEM_PROMPT",
        "MAX_FILE_SIZE_MB",
        "TEMP_DIR",
        "UPLOAD_TIMEOUT_SECONDS",
        "LOG_LEVEL",
        "BACKEND_FORMAT",
        "VAD_BACKEND",
        "DATA_DIR",
        "DATABASE_URL",
    ):
        monkeypatch.delenv(k, raising=False)
    return monkeypatch


def test_defaults(clean_env):
    c = Config()

    assert c.MODEL_NAME == "breeze-asr-25"
    assert c.MODEL_DIR is None
    assert c.COMPUTE_TYPE == "default"
    assert c.DEVICE == "auto"
    assert c.GEMINI_API_KEY is None
    assert c.GEMINI_MODEL is None
    assert c.GEMINI_SYSTEM_PROMPT is None
    assert c.API_PORT == 8000
    assert c.MAX_FILE_SIZE_MB == 100


def test_model_dir_override(clean_env):
    clean_env.setenv("MODEL_DIR", "/opt/models/breeze-int8")
    c = Config()
    assert c.MODEL_DIR == "/opt/models/breeze-int8"
    # MODEL_DIR override does NOT clobber MODEL_NAME — both coexist, resolver picks DIR first.
    assert c.MODEL_NAME == "breeze-asr-25"


def test_model_name_custom(clean_env):
    clean_env.setenv("MODEL_NAME", "large-v3-turbo")
    assert Config().MODEL_NAME == "large-v3-turbo"


def test_compute_type_and_device_overrides(clean_env):
    clean_env.setenv("COMPUTE_TYPE", "int8_float16")
    clean_env.setenv("DEVICE", "cuda")
    c = Config()
    assert c.COMPUTE_TYPE == "int8_float16"
    assert c.DEVICE == "cuda"


def test_gemini_unset_is_none(clean_env):
    c = Config()
    assert c.GEMINI_API_KEY is None
    assert c.GEMINI_MODEL is None
    assert c.GEMINI_SYSTEM_PROMPT is None


def test_gemini_empty_string_preserved(clean_env):
    """Empty string MUST be preserved (not coerced to None) so llm.py can warn on it."""
    clean_env.setenv("GEMINI_MODEL", "")
    clean_env.setenv("GEMINI_SYSTEM_PROMPT", "")
    c = Config()
    assert c.GEMINI_MODEL == ""
    assert c.GEMINI_SYSTEM_PROMPT == ""


def test_gemini_set_values(clean_env):
    clean_env.setenv("GEMINI_API_KEY", "sk-test")
    clean_env.setenv("GEMINI_MODEL", "gemini-2.0-pro")
    clean_env.setenv("GEMINI_SYSTEM_PROMPT", "You are a helpful assistant.")
    c = Config()
    assert c.GEMINI_API_KEY == "sk-test"
    assert c.GEMINI_MODEL == "gemini-2.0-pro"
    assert c.GEMINI_SYSTEM_PROMPT == "You are a helpful assistant."


def test_max_file_size_bytes():
    c = Config()
    c.MAX_FILE_SIZE_MB = 10
    assert c.max_file_size_bytes == 10 * 1024 * 1024


def test_ensure_temp_dir(tmp_path):
    c = Config()
    c.TEMP_DIR = tmp_path / "subdir"
    assert not c.TEMP_DIR.exists()
    c.ensure_temp_dir()
    assert c.TEMP_DIR.exists()


def test_validate_port_invalid():
    c = Config()
    c.API_PORT = 70000
    with pytest.raises(ValueError, match="Invalid API_PORT"):
        c.validate_port()


def test_validate_port_zero():
    c = Config()
    c.API_PORT = 0
    with pytest.raises(ValueError, match="Invalid API_PORT"):
        c.validate_port()


def test_validate_port_ok():
    c = Config()
    c.API_PORT = 8000
    c.validate_port()  # does not raise


def test_persistence_defaults(clean_env):
    """Default data_dir, database_url, audio_dir match the design."""
    from pathlib import Path

    c = Config()
    assert c.DATA_DIR == Path("data")
    assert c.DATABASE_URL == "sqlite:///data/history.db"
    assert c.audio_dir == Path("data") / "audio"


def test_persistence_env_override(clean_env):
    """Env vars override default paths and URL independently."""
    from pathlib import Path

    clean_env.setenv("DATA_DIR", "/tmp/wrap-data")
    clean_env.setenv("DATABASE_URL", "sqlite:///:memory:")
    c = Config()
    assert c.DATA_DIR == Path("/tmp/wrap-data")
    assert c.DATABASE_URL == "sqlite:///:memory:"
    assert c.audio_dir == Path("/tmp/wrap-data/audio")


def test_persistence_data_dir_changes_default_url(clean_env):
    """When only DATA_DIR is set, the default URL is derived from it."""
    clean_env.setenv("DATA_DIR", "/var/lib/wrap")
    c = Config()
    assert c.DATABASE_URL == "sqlite:////var/lib/wrap/history.db"


def test_ensure_data_dirs(tmp_path):
    from app.config import Config

    c = Config()
    c.DATA_DIR = tmp_path / "data"
    assert not c.DATA_DIR.exists()
    assert not c.audio_dir.exists()
    c.ensure_data_dirs()
    assert c.DATA_DIR.is_dir()
    assert c.audio_dir.is_dir()


def test_v1_keys_are_silently_ignored(clean_env, caplog):
    """Per v2.1 model-management REMOVED Requirements: v1 keys SHALL not log."""
    clean_env.setenv("WHISPER_SERVER_HOST", "localhost")
    clean_env.setenv("MODEL_PATH", "./old.bin")
    with caplog.at_level(logging.WARNING, logger="app.config"):
        Config()
    # Config construction SHALL NOT emit any log line naming the v1 keys.
    msgs = [r.getMessage() for r in caplog.records]
    assert not any("WHISPER_SERVER_HOST" in m or "MODEL_PATH" in m for m in msgs)


def test_vad_backend_default_is_none(clean_env):
    """Per v2.2: Config.VAD_BACKEND is None when env unset."""
    c = Config()
    assert c.VAD_BACKEND is None


def test_vad_backend_explicit_silero(clean_env):
    clean_env.setenv("VAD_BACKEND", "silero")
    assert Config().VAD_BACKEND == "silero"


def test_vad_backend_explicit_rms(clean_env):
    clean_env.setenv("VAD_BACKEND", "rms")
    assert Config().VAD_BACKEND == "rms"
