import tempfile
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    """Create a test client."""
    return TestClient(app)


@contextmanager
def _mock_transcription_pipeline():
    """Context manager that mocks the full transcription pipeline.

    Yields (mock_transcribe, temp_input_path) so callers can inspect
    how whisper_client.transcribe was called and use the temp file for uploads.
    """
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_input = Path(temp_dir) / "input.mp3"
        temp_wav = Path(temp_dir) / "output.wav"
        temp_input.write_bytes(b"fake audio data")
        temp_wav.write_bytes(b"fake wav data")

        mock_transcribe = AsyncMock(
            return_value={"text": "Hello world", "language": "en"}
        )

        with patch(
            "app.services.files.file_manager.create_temp_file",
            side_effect=[temp_input, temp_wav],
        ), patch(
            "app.services.files.file_manager.validate_file_size",
            return_value=True,
        ), patch(
            "app.services.files.file_manager.is_audio_file",
            return_value=True,
        ), patch(
            "app.services.converter.audio_converter.convert_to_wav",
            return_value=temp_wav,
        ), patch(
            "app.services.whisper.whisper_client.transcribe",
            mock_transcribe,
        ), patch(
            "app.services.files.file_manager.cleanup_file",
        ):
            yield mock_transcribe, temp_input


def test_root_endpoint(client):
    """Test root endpoint."""
    response = client.get("/")
    assert response.status_code == 200

    data = response.json()
    assert data["name"] == "whisper-wrap"
    assert "endpoints" in data


def test_health_endpoint(client):
    """Test health check endpoint."""
    with patch("app.services.whisper.whisper_client.health_check", return_value=True):
        response = client.get("/health")
        assert response.status_code == 200

        data = response.json()
        assert data["status"] == "healthy"
        assert data["whisper_server"] is True


def test_health_endpoint_degraded(client):
    """Test health check when whisper server is down."""
    with patch("app.services.whisper.whisper_client.health_check", return_value=False):
        response = client.get("/health")
        assert response.status_code == 200

        data = response.json()
        assert data["status"] == "degraded"
        assert data["whisper_server"] is False


def test_transcribe_no_file(client):
    """Test transcribe endpoint without file."""
    response = client.post("/transcribe")
    assert response.status_code == 422  # Validation error


def test_transcribe_empty_filename(client):
    """Test transcribe endpoint with empty filename."""
    response = client.post("/transcribe", files={"file": ("", b"content")})
    # FastAPI returns 422 for validation errors, not 400
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_transcribe_success():
    """Test successful transcription."""
    # Mock all the services
    with patch(
        "app.services.files.file_manager.create_temp_file"
    ) as mock_create, patch(
        "app.services.files.file_manager.validate_file_size", return_value=True
    ), patch("app.services.files.file_manager.is_audio_file", return_value=True), patch(
        "app.services.converter.audio_converter.convert_to_wav"
    ) as mock_convert, patch(
        "app.services.whisper.whisper_client.transcribe"
    ) as mock_transcribe, patch(
        "app.services.files.file_manager.cleanup_file"
    ), tempfile.TemporaryDirectory() as temp_dir:
        # Setup mocks
        temp_input = Path(temp_dir) / "input.mp3"
        temp_wav = Path(temp_dir) / "output.wav"
        temp_input.write_bytes(b"fake audio data")
        temp_wav.write_bytes(b"fake wav data")

        mock_create.side_effect = [temp_input, temp_wav]
        mock_convert.return_value = temp_wav
        mock_transcribe.return_value = {"text": "Hello world", "language": "en"}

        # Test the endpoint
        client = TestClient(app)
        with open(temp_input, "rb") as f:
            response = client.post(
                "/transcribe", files={"file": ("test.mp3", f, "audio/mpeg")}
            )

        assert response.status_code == 200
        data = response.json()
        assert data["text"] == "Hello world"
        assert data["language"] == "en"


# ---------------------------------------------------------------------------
# Language & prompt parameter forwarding tests
# ---------------------------------------------------------------------------


class TestTranscribeLanguageParam:
    """Verify language query parameter is forwarded to whisper_client.transcribe."""

    def test_explicit_language(self):
        """POST /transcribe?language=en forwards language='en'."""
        with _mock_transcription_pipeline() as (mock_transcribe, temp_input):
            client = TestClient(app)
            with open(temp_input, "rb") as f:
                response = client.post(
                    "/transcribe?language=en",
                    files={"file": ("test.mp3", f, "audio/mpeg")},
                )
            assert response.status_code == 200
            mock_transcribe.assert_called_once()
            _, kwargs = mock_transcribe.call_args
            assert kwargs["language"] == "en"

    def test_default_language(self):
        """POST /transcribe without language defaults to 'auto'."""
        with _mock_transcription_pipeline() as (mock_transcribe, temp_input):
            client = TestClient(app)
            with open(temp_input, "rb") as f:
                response = client.post(
                    "/transcribe",
                    files={"file": ("test.mp3", f, "audio/mpeg")},
                )
            assert response.status_code == 200
            mock_transcribe.assert_called_once()
            _, kwargs = mock_transcribe.call_args
            assert kwargs["language"] == "auto"


class TestTranscribePromptParam:
    """Verify prompt query parameter is forwarded to whisper_client.transcribe."""

    def test_explicit_prompt(self):
        """POST /transcribe?prompt=Hello forwards prompt='Hello'."""
        with _mock_transcription_pipeline() as (mock_transcribe, temp_input):
            client = TestClient(app)
            with open(temp_input, "rb") as f:
                response = client.post(
                    "/transcribe?prompt=Hello",
                    files={"file": ("test.mp3", f, "audio/mpeg")},
                )
            assert response.status_code == 200
            mock_transcribe.assert_called_once()
            _, kwargs = mock_transcribe.call_args
            assert kwargs["prompt"] == "Hello"

    def test_default_prompt_is_none(self):
        """POST /transcribe without prompt forwards prompt=None."""
        with _mock_transcription_pipeline() as (mock_transcribe, temp_input):
            client = TestClient(app)
            with open(temp_input, "rb") as f:
                response = client.post(
                    "/transcribe",
                    files={"file": ("test.mp3", f, "audio/mpeg")},
                )
            assert response.status_code == 200
            mock_transcribe.assert_called_once()
            _, kwargs = mock_transcribe.call_args
            assert kwargs["prompt"] is None


class TestTranscribeRawLanguageParam:
    """Verify language query parameter on /transcribe-raw endpoint."""

    def test_explicit_language(self):
        """POST /transcribe-raw?language=zh forwards language='zh'."""
        with _mock_transcription_pipeline() as (mock_transcribe, _):
            client = TestClient(app)
            response = client.post(
                "/transcribe-raw?language=zh",
                content=b"fake audio data",
                headers={"Content-Type": "audio/mp3"},
            )
            assert response.status_code == 200
            mock_transcribe.assert_called_once()
            _, kwargs = mock_transcribe.call_args
            assert kwargs["language"] == "zh"

    def test_default_language(self):
        """POST /transcribe-raw without language defaults to 'auto'."""
        with _mock_transcription_pipeline() as (mock_transcribe, _):
            client = TestClient(app)
            response = client.post(
                "/transcribe-raw",
                content=b"fake audio data",
                headers={"Content-Type": "audio/mp3"},
            )
            assert response.status_code == 200
            mock_transcribe.assert_called_once()
            _, kwargs = mock_transcribe.call_args
            assert kwargs["language"] == "auto"


class TestTranscribeRawPromptParam:
    """Verify prompt query parameter on /transcribe-raw endpoint."""

    def test_explicit_prompt(self):
        """POST /transcribe-raw?prompt=Hello forwards prompt='Hello'."""
        with _mock_transcription_pipeline() as (mock_transcribe, _):
            client = TestClient(app)
            response = client.post(
                "/transcribe-raw?prompt=Hello",
                content=b"fake audio data",
                headers={"Content-Type": "audio/mp3"},
            )
            assert response.status_code == 200
            mock_transcribe.assert_called_once()
            _, kwargs = mock_transcribe.call_args
            assert kwargs["prompt"] == "Hello"

    def test_default_prompt_is_none(self):
        """POST /transcribe-raw without prompt forwards prompt=None."""
        with _mock_transcription_pipeline() as (mock_transcribe, _):
            client = TestClient(app)
            response = client.post(
                "/transcribe-raw",
                content=b"fake audio data",
                headers={"Content-Type": "audio/mp3"},
            )
            assert response.status_code == 200
            mock_transcribe.assert_called_once()
            _, kwargs = mock_transcribe.call_args
            assert kwargs["prompt"] is None


class TestCombinedParams:
    """Verify both language and prompt can be used together."""

    def test_transcribe_both_params(self):
        """POST /transcribe?language=en&prompt=Meeting notes forwards both."""
        with _mock_transcription_pipeline() as (mock_transcribe, temp_input):
            client = TestClient(app)
            with open(temp_input, "rb") as f:
                response = client.post(
                    "/transcribe?language=en&prompt=Meeting%20notes",
                    files={"file": ("test.mp3", f, "audio/mpeg")},
                )
            assert response.status_code == 200
            mock_transcribe.assert_called_once()
            _, kwargs = mock_transcribe.call_args
            assert kwargs["language"] == "en"
            assert kwargs["prompt"] == "Meeting notes"

    def test_transcribe_raw_both_params(self):
        """POST /transcribe-raw?language=ja&prompt=Conversation forwards both."""
        with _mock_transcription_pipeline() as (mock_transcribe, _):
            client = TestClient(app)
            response = client.post(
                "/transcribe-raw?language=ja&prompt=Conversation",
                content=b"fake audio data",
                headers={"Content-Type": "audio/mp3"},
            )
            assert response.status_code == 200
            mock_transcribe.assert_called_once()
            _, kwargs = mock_transcribe.call_args
            assert kwargs["language"] == "ja"
            assert kwargs["prompt"] == "Conversation"
