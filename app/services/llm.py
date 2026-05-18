"""Gemini LLM client for POST /ask.

Reads `GEMINI_API_KEY`, `GEMINI_MODEL`, and `GEMINI_SYSTEM_PROMPT` at construction
time (the FastAPI lifespan instantiates one shared `LLMClient`). Forwards the
configured system prompt verbatim on every call.

Fallback policy (per spec):
- `GEMINI_SYSTEM_PROMPT` unset (None) → silently use the baked-in Taiwan persona.
- `GEMINI_SYSTEM_PROMPT` empty string  → use the persona AND emit a one-line WARNING.
- `GEMINI_MODEL` unset (None) → silently use `gemini-3.1-flash-lite`.
- `GEMINI_MODEL` empty string  → use `gemini-3.1-flash-lite` AND emit a one-line WARNING.
"""

import asyncio
import logging
from collections.abc import AsyncIterator

from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"

# Baked-in default system prompt: short Taiwan-friendly assistant persona that the
# operator can override via `GEMINI_SYSTEM_PROMPT`.
DEFAULT_SYSTEM_PROMPT = (
    "你是一個語音助理。使用者會用語音或文字向你提問，請以簡潔、自然、口語化的方式回答。"
    "預設使用台灣繁體中文回答，除非使用者明確使用其他語言。"
)


class LLMConfigError(RuntimeError):
    """Raised when the LLM is asked to do something it is not configured for (e.g. no API key)."""


class LLMUpstreamError(RuntimeError):
    """Raised when the Gemini API returns an error or is unreachable."""


def _resolve_system_prompt(raw: str | None) -> str:
    if raw is None:
        return DEFAULT_SYSTEM_PROMPT
    if raw == "":
        logger.warning(
            "GEMINI_SYSTEM_PROMPT is set but empty — using baked-in Taiwan-friendly persona"
        )
        return DEFAULT_SYSTEM_PROMPT
    return raw


def _resolve_model(raw: str | None) -> str:
    if raw is None:
        return DEFAULT_GEMINI_MODEL
    if raw == "":
        logger.warning(
            "GEMINI_MODEL is set but empty — using default %s", DEFAULT_GEMINI_MODEL
        )
        return DEFAULT_GEMINI_MODEL
    return raw


class LLMClient:
    """Single-shot and streaming Gemini wrapper."""

    def __init__(
        self,
        api_key: str | None,
        model: str | None,
        system_prompt: str | None,
        *,
        client_factory=None,
    ):
        self.api_key = api_key or None
        self.model = _resolve_model(model)
        self.system_prompt = _resolve_system_prompt(system_prompt)
        self._client_factory = client_factory or genai.Client
        self._client = None

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def _ensure_client(self):
        if not self.api_key:
            raise LLMConfigError("GEMINI_API_KEY is not configured")
        if self._client is None:
            self._client = self._client_factory(api_key=self.api_key)
        return self._client

    def _config(self) -> types.GenerateContentConfig:
        return types.GenerateContentConfig(system_instruction=self.system_prompt)

    async def ask(self, user_text: str) -> str:
        """Single-shot completion. Returns the answer text (empty string if Gemini returned none)."""
        client = self._ensure_client()
        try:
            response = await asyncio.to_thread(
                client.models.generate_content,
                model=self.model,
                contents=user_text,
                config=self._config(),
            )
            return response.text or ""
        except LLMConfigError:
            raise
        except Exception as e:
            raise LLMUpstreamError(f"Gemini call failed: {e}") from e

    async def ask_stream(self, user_text: str) -> AsyncIterator[str]:
        """Yield token-level text deltas as Gemini streams them."""
        client = self._ensure_client()
        try:
            stream = client.aio.models.generate_content_stream(
                model=self.model,
                contents=user_text,
                config=self._config(),
            )
            if asyncio.iscoroutine(stream):
                stream = await stream
            async for chunk in stream:
                text = getattr(chunk, "text", None)
                if text:
                    yield text
        except LLMConfigError:
            raise
        except Exception as e:
            raise LLMUpstreamError(f"Gemini streaming failed: {e}") from e
