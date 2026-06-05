"""Unit tests for app/services/llm.py (Gemini wrapper config policies + forwarding)."""

import logging
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services.llm import (
    DEFAULT_GEMINI_MODEL,
    DEFAULT_SYSTEM_PROMPT,
    LLMClient,
    LLMConfigError,
    LLMUpstreamError,
)


def _client(
    *,
    api_key=None,
    model=None,
    system_prompt=None,
    factory=None,
):
    return LLMClient(
        api_key=api_key,
        model=model,
        system_prompt=system_prompt,
        client_factory=factory or MagicMock(),
    )


# ---------- Config resolution (task 4.1 verification cases) ----------


def test_custom_system_prompt_forwarded_verbatim():
    c = _client(api_key="k", system_prompt="custom persona")
    assert c.system_prompt == "custom persona"


def test_unset_system_prompt_uses_default_silently(caplog):
    with caplog.at_level(logging.WARNING, logger="app.services.llm"):
        c = _client(api_key="k", system_prompt=None)
    assert c.system_prompt == DEFAULT_SYSTEM_PROMPT
    assert not any("GEMINI_SYSTEM_PROMPT" in r.getMessage() for r in caplog.records)


def test_empty_system_prompt_uses_default_with_warning(caplog):
    with caplog.at_level(logging.WARNING, logger="app.services.llm"):
        c = _client(api_key="k", system_prompt="")
    assert c.system_prompt == DEFAULT_SYSTEM_PROMPT
    assert any(
        r.levelno == logging.WARNING and "GEMINI_SYSTEM_PROMPT" in r.getMessage()
        for r in caplog.records
    )


def test_unset_model_uses_default_silently(caplog):
    with caplog.at_level(logging.WARNING, logger="app.services.llm"):
        c = _client(api_key="k", model=None)
    assert c.model == DEFAULT_GEMINI_MODEL
    assert not any("GEMINI_MODEL" in r.getMessage() for r in caplog.records)


def test_empty_model_uses_default_with_warning(caplog):
    with caplog.at_level(logging.WARNING, logger="app.services.llm"):
        c = _client(api_key="k", model="")
    assert c.model == DEFAULT_GEMINI_MODEL
    assert any(
        r.levelno == logging.WARNING and "GEMINI_MODEL" in r.getMessage()
        for r in caplog.records
    )


def test_configured_property():
    assert _client(api_key="k").configured is True
    assert _client(api_key=None).configured is False
    assert _client(api_key="").configured is False


# ---------- ask() forwarding ----------


async def test_ask_raises_llmconfigerror_when_key_missing():
    c = _client(api_key=None)
    with pytest.raises(LLMConfigError):
        await c.ask("hi")


async def test_ask_forwards_model_contents_and_system_instruction():
    fake_response = SimpleNamespace(text="hello back")
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_response
    factory = MagicMock(return_value=fake_client)

    c = _client(api_key="k", model="m-pro", system_prompt="sp", factory=factory)
    answer = await c.ask("user question")

    assert answer == "hello back"
    factory.assert_called_once_with(api_key="k")
    call = fake_client.models.generate_content.call_args
    assert call.kwargs["model"] == "m-pro"
    assert call.kwargs["contents"] == "user question"
    assert call.kwargs["config"].system_instruction == "sp"


async def test_ask_returns_empty_string_for_none_text():
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = SimpleNamespace(text=None)
    c = _client(api_key="k", factory=MagicMock(return_value=fake_client))
    assert await c.ask("hi") == ""


async def test_ask_maps_upstream_error():
    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = Exception("rate limited")
    c = _client(api_key="k", factory=MagicMock(return_value=fake_client))
    with pytest.raises(LLMUpstreamError, match="rate limited"):
        await c.ask("hi")


# ---------- ask_stream() forwarding ----------


async def _drain(agen) -> list[str]:
    return [x async for x in agen]


async def test_ask_stream_raises_when_key_missing():
    c = _client(api_key=None)
    with pytest.raises(LLMConfigError):
        async for _ in c.ask_stream("hi"):
            pass


async def test_ask_stream_yields_chunk_texts_and_skips_empty():
    chunks = [
        SimpleNamespace(text="hel"),
        SimpleNamespace(text="lo"),
        SimpleNamespace(text=""),
        SimpleNamespace(text=None),
        SimpleNamespace(text=" world"),
    ]

    async def fake_stream(*, model, contents, config):
        for c in chunks:
            yield c

    fake_client = MagicMock()
    fake_client.aio.models.generate_content_stream = fake_stream
    c = _client(api_key="k", factory=MagicMock(return_value=fake_client))

    received = await _drain(c.ask_stream("hi"))
    assert received == ["hel", "lo", " world"]


async def test_ask_stream_maps_upstream_error():
    async def boom(*, model, contents, config):
        raise RuntimeError("upstream burst")
        yield  # pragma: no cover

    fake_client = MagicMock()
    fake_client.aio.models.generate_content_stream = boom
    c = _client(api_key="k", factory=MagicMock(return_value=fake_client))

    with pytest.raises(LLMUpstreamError, match="upstream burst"):
        await _drain(c.ask_stream("hi"))
