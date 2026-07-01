/**
 * Unit tests for the AI-config client.
 *
 * The module no longer takes a per-call `fetchImpl`; transport + the swappable
 * test seam live in the shared generated client. Each test stubs the client's
 * ONE `fetch` (`setClientFetch`) and asserts on the emitted `Request`'s
 * method / URL / body — the same route/method/body guarantee the old
 * `fetchImpl` assertions gave, just targeting the new seam.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { resetClientFetch, setClientFetch } from "./client";
import { getAiConfig, putAiConfig, listAiModels, testAiConfig } from "./ai-config";
import type { components } from "./generated/openapi";

type AiConfigView = components["schemas"]["AiConfigView"];

afterEach(() => {
  resetClientFetch();
  vi.restoreAllMocks();
});

/** A JSON Response for the client's injectable `fetch` seam. */
function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The single `Request` the client emitted (replaces the old `fetchImpl`
 * inspection — assert on the emitted Request's method/URL/body). */
function emittedRequest(mock: ReturnType<typeof vi.fn>): Request {
  return mock.mock.calls[0][0] as Request;
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
    const fetchMock = vi.fn(async () => jsonResp(view));
    setClientFetch(fetchMock as unknown as typeof fetch);

    const got = await getAiConfig();

    const req = emittedRequest(fetchMock);
    expect(req.method).toBe("GET");
    expect(new URL(req.url).pathname).toBe("/config/ai");
    expect(got).toEqual(view);
    // The shape carries no raw-key field.
    expect(Object.keys(got)).not.toContain("apiKey");
    expect(JSON.stringify(got)).not.toContain("AIzaSyRAWKEY");
  });

  it("getAiConfig throws on a non-ok response", async () => {
    const fetchMock = vi.fn(async () => jsonResp({}, 500));
    setClientFetch(fetchMock as unknown as typeof fetch);

    await expect(getAiConfig()).rejects.toThrow(/500/);
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
    const fetchMock = vi.fn(async () => jsonResp(view));
    setClientFetch(fetchMock as unknown as typeof fetch);

    const got = await putAiConfig({
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-secret",
      systemPrompt: "be terse",
    });

    const req = emittedRequest(fetchMock);
    expect(req.method).toBe("PUT");
    expect(new URL(req.url).pathname).toBe("/config/ai");
    expect(await req.json()).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-secret",
      systemPrompt: "be terse",
    });
    expect(got).toEqual(view);
  });

  it("putAiConfig forwards an empty apiKey verbatim (keep stored key)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResp({
        provider: "gemini",
        baseUrl: "",
        model: "gemini-3.1-flash-lite",
        keySet: true,
        keyHint: "AIza…9b2c",
        systemPromptSet: false,
      }),
    );
    setClientFetch(fetchMock as unknown as typeof fetch);

    await putAiConfig({
      provider: "gemini",
      baseUrl: "",
      model: "gemini-3.1-flash-lite",
      apiKey: "",
    });

    const body = (await emittedRequest(fetchMock).json()) as { apiKey: string };
    expect(body.apiKey).toBe("");
  });

  it("listAiModels GETs the discovery endpoint with provider/baseUrl/apiKey query", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResp({ models: ["a", "b"], error: null }),
    );
    setClientFetch(fetchMock as unknown as typeof fetch);

    const got = await listAiModels({
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "",
      apiKey: "k",
    });

    const url = new URL(emittedRequest(fetchMock).url);
    expect(url.pathname).toBe("/config/ai/models");
    expect(url.searchParams.get("provider")).toBe("openai-compatible");
    expect(url.searchParams.get("baseUrl")).toBe("http://localhost:11434/v1");
    expect(url.searchParams.get("apiKey")).toBe("k");
    expect(got).toEqual({ models: ["a", "b"], error: null });
  });

  it("listAiModels surfaces the error-with-empty-list shape", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResp({ models: [], error: "auth failed" }),
    );
    setClientFetch(fetchMock as unknown as typeof fetch);

    const got = await listAiModels({
      provider: "gemini",
      baseUrl: "",
      model: "",
      apiKey: "bad",
    });

    expect(got).toEqual({ models: [], error: "auth failed" });
  });

  it("testAiConfig POSTs the probe and returns ok/error", async () => {
    const fetchMock = vi.fn(async () => jsonResp({ ok: true, error: null }));
    setClientFetch(fetchMock as unknown as typeof fetch);

    const got = await testAiConfig({
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
      apiKey: "",
    });

    const req = emittedRequest(fetchMock);
    expect(req.method).toBe("POST");
    expect(new URL(req.url).pathname).toBe("/config/ai/test");
    expect(await req.json()).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
      apiKey: "",
    });
    expect(got).toEqual({ ok: true, error: null });
  });
});
