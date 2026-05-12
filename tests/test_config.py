"""Tests for v2 Config (in-process faster-whisper backend)."""

import logging
from pathlib import Path

import pytest

from app.config import Config, warn_obsolete_env_vars

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
    """Strip both v1 and v2 model/LLM env vars so default-resolution tests are deterministic."""
    for k in (
        *OBSOLETE_V1_KEYS,
        "MODEL_NAME",
        "MODEL_DIR",
        "COMPUTE_TYPE",
        "DEVICE",
        "GEMINI_API_KEY",
        "GEMINI_MODEL",
        "GEMINI_SYSTEM_PROMPT",
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


@pytest.mark.parametrize("obsolete_key", OBSOLETE_V1_KEYS)
def test_obsolete_v1_key_emits_warning(clean_env, caplog, obsolete_key):
    """Each removed v1 env var SHALL trigger exactly one WARNING when present."""
    clean_env.setenv(obsolete_key, "anything")

    with caplog.at_level(logging.WARNING, logger="app.config"):
        warn_obsolete_env_vars()

    matches = [r for r in caplog.records if obsolete_key in r.getMessage()]
    assert len(matches) == 1, f"Expected 1 WARNING for {obsolete_key}, got {len(matches)}"
    assert matches[0].levelno == logging.WARNING


def test_no_warning_when_clean(clean_env, caplog):
    """When zero obsolete vars are set, no obsolete-key WARNING fires."""
    with caplog.at_level(logging.WARNING, logger="app.config"):
        warn_obsolete_env_vars()
    assert not any("Obsolete v1 env var" in r.getMessage() for r in caplog.records)


def test_warn_obsolete_returns_detected_keys(clean_env):
    """The helper returns the detected keys list (for downstream observability/testing)."""
    clean_env.setenv("WHISPER_SERVER_HOST", "x")
    clean_env.setenv("MODEL_PATH", "y")
    detected = warn_obsolete_env_vars()
    assert set(detected) == {"WHISPER_SERVER_HOST", "MODEL_PATH"}
