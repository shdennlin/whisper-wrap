import logging
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

from app.config import config
from app.services.punctuation import (
    detect_text_language,
    join_newline_segments,
    normalize_punctuation,
)

logger = logging.getLogger(__name__)

# Default prompt to guide Whisper into producing proper punctuation.
# Whisper imitates the *style* of the prompt (not instructions within it),
# so we provide bilingual punctuated examples. The prompt window is 224 tokens max.
_DEFAULT_PUNCTUATION_PROMPT = (
    "以下是語音轉錄的內容，包含正確的標點符號。"
    "Hello, this is a transcription. We use commas, periods, and question marks. "
    "這段文字有逗號、句號、問號？都是正確的標點。"
)


class WhisperClient:
    """HTTP client for communicating with whisper-server."""

    def __init__(self):
        self.timeout = config.UPLOAD_TIMEOUT_SECONDS

    @property
    def base_url(self) -> str:
        """Get the current whisper server URL."""
        return config.whisper_server_url

    async def transcribe(
        self,
        wav_file_path: Path,
        *,
        language: str = "auto",
        prompt: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send WAV file to whisper-server for transcription.

        Forwards language and prompt to whisper-server's /inference endpoint.
        The text output is stripped of trailing whitespace/newlines.
        """
        if not wav_file_path.exists():
            raise FileNotFoundError(f"WAV file not found: {wav_file_path}")

        files = {"file": ("audio.wav", open(wav_file_path, "rb"), "audio/wav")}

        effective_prompt = prompt or _DEFAULT_PUNCTUATION_PROMPT

        data = {
            "temperature": "0.0",
            "temperature_inc": "0.2",
            "response_format": "json",
            "language": language,
            "prompt": effective_prompt,
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

                result = response.json()

                if "text" in result:
                    raw_text = result["text"]
                    text = raw_text.strip()
                    detected_lang = detect_text_language(text)
                    joined_text = join_newline_segments(text)
                    normalized_text = normalize_punctuation(joined_text, detected_lang)

                    if logger.isEnabledFor(logging.DEBUG):
                        logger.debug(
                            "Transcription result:\n"
                            "  prompt:     %r\n"
                            "  raw:        %r\n"
                            "  detected:   %s\n"
                            "  joined:     %r\n"
                            "  normalized: %r",
                            effective_prompt, raw_text, detected_lang,
                            joined_text, normalized_text,
                        )

                    result = {**result, "text": normalized_text}

                return result

        except httpx.TimeoutException:
            raise RuntimeError(f"Whisper server timeout after {self.timeout} seconds")
        except httpx.ConnectError:
            raise RuntimeError(f"Cannot connect to whisper server at {self.base_url}")
        finally:
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
