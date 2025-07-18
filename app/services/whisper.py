from pathlib import Path
from typing import Any, Dict

import httpx

from app.config import config


class WhisperClient:
    """HTTP client for communicating with whisper-server."""

    def __init__(self):
        self.base_url = config.WHISPER_SERVER_URL
        self.timeout = config.UPLOAD_TIMEOUT_SECONDS

    async def transcribe(self, wav_file_path: Path) -> Dict[str, Any]:
        """Send WAV file to whisper-server for transcription."""
        if not wav_file_path.exists():
            raise FileNotFoundError(f"WAV file not found: {wav_file_path}")

        # Prepare the request data as expected by whisper-server
        files = {"file": ("audio.wav", open(wav_file_path, "rb"), "audio/wav")}

        data = {
            "temperature": "0.0",
            "temperature_inc": "0.2",
            "response_format": "json",
        }

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    f"{self.base_url}/inference", files=files, data=data
                )

                if response.status_code != 200:
                    raise RuntimeError(
                        f"Whisper server error {response.status_code}: {response.text}"
                    )

                return response.json()

        except httpx.TimeoutException:
            raise RuntimeError(f"Whisper server timeout after {self.timeout} seconds")
        except httpx.ConnectError:
            raise RuntimeError(f"Cannot connect to whisper server at {self.base_url}")
        finally:
            # Ensure file is closed
            if "files" in locals():
                files["file"][1].close()

    async def health_check(self) -> bool:
        """Check if whisper-server is responding."""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                response = await client.get(f"{self.base_url}/health")
                return response.status_code == 200
        except (httpx.TimeoutException, httpx.ConnectError):
            return False


whisper_client = WhisperClient()
