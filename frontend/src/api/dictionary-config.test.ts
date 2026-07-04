/**
 * Unit tests for the dictionary-config client (zh-convert-dictionary).
 *
 * Transport + the swappable test seam live in the shared generated client.
 * Each test stubs the client's ONE `fetch` (`setClientFetch`) and asserts on
 * the emitted `Request`'s method / URL / body plus the response handling —
 * the same pattern as `ai-config.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { resetClientFetch, setClientFetch } from "./client";
import {
  getDictionaryConfig,
  putDictionaryConfig,
  type DictionaryConfig,
} from "./dictionary-config";

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

/** The single `Request` the client emitted (assert on method/URL/body). */
function emittedRequest(mock: ReturnType<typeof vi.fn>): Request {
  return mock.mock.calls[0][0] as Request;
}

describe("dictionary-config client", () => {
  it("getDictionaryConfig GETs /config/dictionary and returns the parsed config", async () => {
    const cfg: DictionaryConfig = {
      zh_convert: "s2tw",
      replacements: [{ from: "Cloud Code", to: "Claude Code" }],
    };
    const fetchMock = vi.fn(async () => jsonResp(cfg));
    setClientFetch(fetchMock as unknown as typeof fetch);

    const got = await getDictionaryConfig();

    const req = emittedRequest(fetchMock);
    expect(req.method).toBe("GET");
    expect(new URL(req.url).pathname).toBe("/config/dictionary");
    expect(got).toEqual(cfg);
  });

  it("putDictionaryConfig PUTs the config as JSON body and returns the stored config", async () => {
    const cfg: DictionaryConfig = {
      zh_convert: "off",
      replacements: [
        { from: "Cloud Code", to: "Claude Code" },
        { from: "wisper", to: "whisper" },
      ],
    };
    const fetchMock = vi.fn(async () => jsonResp(cfg));
    setClientFetch(fetchMock as unknown as typeof fetch);

    const got = await putDictionaryConfig(cfg);

    const req = emittedRequest(fetchMock);
    expect(req.method).toBe("PUT");
    expect(new URL(req.url).pathname).toBe("/config/dictionary");
    expect(await req.json()).toEqual({
      zh_convert: "off",
      replacements: [
        { from: "Cloud Code", to: "Claude Code" },
        { from: "wisper", to: "whisper" },
      ],
    });
    expect(got).toEqual(cfg);
  });

  it("putDictionaryConfig surfaces the ApiError detail from a 400", async () => {
    const fetchMock = vi.fn(async () => jsonResp({ detail: "boom" }, 400));
    setClientFetch(fetchMock as unknown as typeof fetch);

    await expect(
      putDictionaryConfig({ zh_convert: "s2tw", replacements: [] }),
    ).rejects.toThrow(/boom/);
  });

  it("getDictionaryConfig falls back to a status-code message on a detail-less failure", async () => {
    const fetchMock = vi.fn(async () => jsonResp({}, 500));
    setClientFetch(fetchMock as unknown as typeof fetch);

    await expect(getDictionaryConfig()).rejects.toThrow(/500/);
  });
});
