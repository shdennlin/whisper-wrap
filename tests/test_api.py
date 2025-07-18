import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    """Create a test client."""
    return TestClient(app)


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
