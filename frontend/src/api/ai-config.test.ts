/**
 * Unit tests for the AI-config client. Each method gets a stubbed fetch so we
 * assert the exact URL, method, body, and that the raw key never appears in a
 * read response shape.
 */

import { describe, it, expect, vi } from "vitest";
import {
  getAiConfig,
  putAiConfig,
  listAiModels,
  testAiConfig,
  type AiConfigView,
} from "./ai-config";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe("ai-config client", () => {
  it("getAiConfig GETs /config/ai and returns the masked view (no raw key)", async () => {
    const view: AiConfigView = {
      provider: "gemini",
      baseUrl: "",
      model: "gemini-3.1-flash-lite",
      keySet: true,
      keyHint: "AIza…9b2c",
      systemPromptSet: false,
    };
    const fetchImpl = vi.fn(async () => jsonResponse(view));
    const got = await getAiConfig(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("/config/ai");
    expect(got).toEqual(view);
    // The shape carries no raw-key field.
    expect(Object.keys(got)).not.toContain("apiKey");
    expect(JSON.stringify(got)).not.toContain("AIzaSyRAWKEY");
  });

  it("getAiConfig throws on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 500));
    await expect(
      getAiConfig(fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/500/);
  });

  it("putAiConfig PUTs the update body and returns the masked view", async () => {
    const view: AiConfigView = {
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "gpt-4o-mini",
      keySet: true,
      keyHint: "sk-…1234",
      systemPromptSet: true,
    };
    const fetchImpl = vi.fn(async () => jsonResponse(view));
    const got = await putAiConfig(
      {
        provider: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "gpt-4o-mini",
        apiKey: "sk-secret",
        systemPrompt: "be terse",
      },
      fetchImpl as unknown as typeof fetch,
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/config/ai");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-secret",
      systemPrompt: "be terse",
    });
    expect(got).toEqual(view);
  });

  it("putAiConfig forwards an empty apiKey verbatim (keep stored key)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        provider: "gemini",
        baseUrl: "",
        model: "gemini-3.1-flash-lite",
        keySet: true,
        keyHint: "AIza…9b2c",
        systemPromptSet: false,
      }),
    );
    await putAiConfig(
      {
        provider: "gemini",
        baseUrl: "",
        model: "gemini-3.1-flash-lite",
        apiKey: "",
      },
      fetchImpl as unknown as typeof fetch,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string).apiKey).toBe("");
  });

  it("listAiModels GETs the discovery endpoint with provider/baseUrl/apiKey query", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ models: ["a", "b"], error: null }),
    );
    const got = await listAiModels(
      {
        provider: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        model: "",
        apiKey: "k",
      },
      fetchImpl as unknown as typeof fetch,
    );
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain("/config/ai/models?");
    expect(url).toContain("provider=openai-compatible");
    expect(url).toContain("baseUrl=http%3A%2F%2Flocalhost%3A11434%2Fv1");
    expect(url).toContain("apiKey=k");
    expect(got).toEqual({ models: ["a", "b"], error: null });
  });

  it("listAiModels surfaces the error-with-empty-list shape", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ models: [], error: "auth failed" }),
    );
    const got = await listAiModels(
      { provider: "gemini", baseUrl: "", model: "", apiKey: "bad" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(got).toEqual({ models: [], error: "auth failed" });
  });

  it("testAiConfig POSTs the probe and returns ok/error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, error: null }));
    const got = await testAiConfig(
      {
        provider: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        model: "llama3",
        apiKey: "",
      },
      fetchImpl as unknown as typeof fetch,
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/config/ai/test");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
      apiKey: "",
    });
    expect(got).toEqual({ ok: true, error: null });
  });
});
