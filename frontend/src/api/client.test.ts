/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from "vitest";
import { baseUrlMiddleware } from "./client";

/**
 * Regression guard for the WKWebView upload bug: the base-URL middleware MUST
 * NOT re-wrap a same-origin request into a `new Request(...)`, because that
 * transfers a `Blob`/`FormData` upload body into a `ReadableStream`, which the
 * desktop WKWebView shell cannot upload ("ReadableStream uploading is not
 * supported"). For same-origin it returns `undefined` (leave the request as-is);
 * only a custom cross-origin backend triggers a redirect.
 */
function onRequest(request: Request): Request | undefined {
  // openapi-fetch's onRequest receives more fields; the middleware only reads
  // `request`, so a partial context is sufficient for this unit test.
  return baseUrlMiddleware.onRequest?.({ request } as never) as
    | Request
    | undefined;
}

afterEach(() => {
  localStorage.clear();
});

describe("client base-URL middleware", () => {
  it("leaves a same-origin request untouched (no Blob→ReadableStream re-wrap)", () => {
    // Default settings → backendUrl() === window.location.origin.
    const req = new Request(`${window.location.origin}/transcribe`, {
      method: "POST",
      body: new Blob([new Uint8Array([1, 2, 3])]),
    });
    expect(onRequest(req)).toBeUndefined();
  });

  it("redirects to a custom cross-origin backend when one is configured", () => {
    localStorage.setItem(
      "whisper-wrap.settings",
      JSON.stringify({ backendUrl: "http://example.test:9000" }),
    );
    const req = new Request(`${window.location.origin}/v1/sessions`, {
      method: "GET",
    });
    const out = onRequest(req);
    expect(out).toBeInstanceOf(Request);
    expect(new URL(out!.url).origin).toBe("http://example.test:9000");
    expect(new URL(out!.url).pathname).toBe("/v1/sessions");
  });
});
