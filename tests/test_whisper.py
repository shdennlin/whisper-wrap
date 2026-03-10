from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.whisper import WhisperClient, _DEFAULT_PUNCTUATION_PROMPT


@pytest.fixture
def wav_file(tmp_path):
    """Create a temporary WAV file for testing."""
    wav_path = tmp_path / "test.wav"
    wav_path.write_bytes(b"RIFF\x00\x00\x00\x00WAVEfmt ")
    return wav_path


@pytest.fixture
def client():
    """Create a WhisperClient instance."""
    return WhisperClient()


def _mock_response(text="Hello world."):
    """Build a mock httpx response with the given text."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"text": text}
    return resp


def _extract_form_data(mock_post):
    """Extract the `data` dict passed to client.post()."""
    _, kwargs = mock_post.call_args
    return kwargs["data"]


@pytest.mark.asyncio
async def test_both_language_and_prompt_forwarded(client, wav_file):
    """WHEN transcribe() is called with language and prompt,
    THEN form data includes both values."""
    mock_post = AsyncMock(return_value=_mock_response())

    with patch("app.services.whisper.httpx.AsyncClient") as mock_cls:
        mock_cls.return_value.__aenter__ = AsyncMock(
            return_value=MagicMock(post=mock_post)
        )
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        await client.transcribe(wav_file, language="en", prompt="Hello.")

    data = _extract_form_data(mock_post)
    assert data["language"] == "en"
    assert data["prompt"] == "Hello."


@pytest.mark.asyncio
async def test_only_language_forwarded_uses_default_prompt(client, wav_file):
    """WHEN transcribe() is called with language but no prompt,
    THEN form data includes language and the default punctuation prompt."""
    mock_post = AsyncMock(return_value=_mock_response())

    with patch("app.services.whisper.httpx.AsyncClient") as mock_cls:
        mock_cls.return_value.__aenter__ = AsyncMock(
            return_value=MagicMock(post=mock_post)
        )
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        await client.transcribe(wav_file, language="zh")

    data = _extract_form_data(mock_post)
    assert data["language"] == "zh"
    assert data["prompt"] == _DEFAULT_PUNCTUATION_PROMPT


@pytest.mark.asyncio
async def test_default_language_is_auto(client, wav_file):
    """WHEN transcribe() is called without language,
    THEN form data uses 'auto' as the default language."""
    mock_post = AsyncMock(return_value=_mock_response())

    with patch("app.services.whisper.httpx.AsyncClient") as mock_cls:
        mock_cls.return_value.__aenter__ = AsyncMock(
            return_value=MagicMock(post=mock_post)
        )
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        await client.transcribe(wav_file)

    data = _extract_form_data(mock_post)
    assert data["language"] == "auto"


@pytest.mark.asyncio
async def test_no_prompt_uses_default_punctuation_prompt(client, wav_file):
    """WHEN transcribe() is called without prompt,
    THEN form data includes _DEFAULT_PUNCTUATION_PROMPT."""
    mock_post = AsyncMock(return_value=_mock_response())

    with patch("app.services.whisper.httpx.AsyncClient") as mock_cls:
        mock_cls.return_value.__aenter__ = AsyncMock(
            return_value=MagicMock(post=mock_post)
        )
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        await client.transcribe(wav_file)

    data = _extract_form_data(mock_post)
    assert data["prompt"] == _DEFAULT_PUNCTUATION_PROMPT


@pytest.mark.asyncio
async def test_post_processing_pipeline_runs(client, wav_file):
    """WHEN whisper-server returns text,
    THEN detect_text_language, join_newline_segments, and normalize_punctuation
    are applied to the result."""
    mock_post = AsyncMock(return_value=_mock_response("  Raw text\n"))

    with (
        patch("app.services.whisper.httpx.AsyncClient") as mock_cls,
        patch("app.services.whisper.detect_text_language", return_value="en") as mock_detect,
        patch("app.services.whisper.join_newline_segments", return_value="Raw text") as mock_join,
        patch("app.services.whisper.normalize_punctuation", return_value="Raw text.") as mock_norm,
    ):
        mock_cls.return_value.__aenter__ = AsyncMock(
            return_value=MagicMock(post=mock_post)
        )
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        result = await client.transcribe(wav_file)

    # strip() is called first on the raw text
    mock_detect.assert_called_once_with("Raw text")
    mock_join.assert_called_once_with("Raw text")
    mock_norm.assert_called_once_with("Raw text", "en")
    assert result["text"] == "Raw text."


@pytest.mark.asyncio
async def test_file_not_found_raises(client, tmp_path):
    """WHEN wav_file_path does not exist,
    THEN FileNotFoundError is raised."""
    missing = tmp_path / "missing.wav"

    with pytest.raises(FileNotFoundError, match="WAV file not found"):
        await client.transcribe(missing)
