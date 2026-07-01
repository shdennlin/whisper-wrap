/**
 * The single configured engine API client (fe-api-client-codegen, task 1.2).
 *
 * ONE `openapi-fetch` client, typed against the generated `paths` contract, is
 * created here and imported directly by the domain modules (tasks 2.x). There
 * is exactly one place the contract meets the network: contract types →
 * `openapi-fetch` → `fetch`.
 *
 * Design decisions realized here:
 *
 *   - **Base URL per call, not fixed at construction.** A request middleware
 *     (`onRequest`) rewrites each request's origin from the canonical
 *     `backendUrl()` at call time. `backendUrl()` re-reads settings on every
 *     call, so a backend-URL settings change takes effect without a reload —
 *     matching the pre-codegen local closures. We deliberately do NOT bind a
 *     fixed `baseUrl` at construction (that would freeze the origin).
 *
 *   - **No bearer header is added.** Same-origin requests carry the
 *     `engine_token` cookie automatically (default `credentials: "same-origin"`
 *     is preserved when the middleware re-wraps the Request). None of the
 *     domain modules migrated in this change send a bearer today, so none gains
 *     one — auth is unchanged.
 *
 *   - **Injectable `fetch` test seam.** The client calls through a swappable
 *     module-level `fetch` (`setClientFetch` / `resetClientFetch`) so tests can
 *     stub the ONE `fetch` and assert on the emitted `Request` (method, URL,
 *     body). This replaces the per-call `fetchImpl` seam the hand-written
 *     modules used.
 */
import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./generated/openapi";
import { backendUrl } from "./backend-url";

/**
 * The one `fetch` the client calls. Tests swap it via `setClientFetch` to
 * intercept and assert on emitted requests; production uses `globalThis.fetch`.
 */
let clientFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/** Swap the client's `fetch` (test seam). Returns nothing; pair with reset. */
export function setClientFetch(f: typeof fetch): void {
  clientFetch = f;
}

/** Restore the client's `fetch` to `globalThis.fetch` (test teardown). */
export function resetClientFetch(): void {
  clientFetch = (input, init) => globalThis.fetch(input, init);
}

/**
 * Per-call base-URL middleware. `openapi-fetch` builds a Request whose URL
 * resolves against the document origin (no fixed `baseUrl`); when the configured
 * backend is a DIFFERENT origin (a custom "Backend URL" web self-host override),
 * we redirect the request there, re-reading `backendUrl()` per call.
 *
 * **Same-origin fast path — do NOT re-wrap the Request.** When `backendUrl()`
 * equals the document origin (the default, and every desktop-shell / Vite-proxy
 * case), the request `openapi-fetch` already built is correct as-is, so we
 * return `undefined` and leave it untouched. This is load-bearing: rebuilding it
 * as `new Request(target, request)` would transfer a `Blob`/`FormData` upload
 * body into a `ReadableStream`, which the desktop WKWebView shell cannot upload
 * ("ReadableStream uploading is not supported") — breaking `/transcribe` and the
 * audio uploads. Leaving the request untouched keeps the body a `Blob`/`FormData`
 * and preserves the same-origin `engine_token` cookie.
 */
export const baseUrlMiddleware: Middleware = {
  onRequest({ request }) {
    const base = backendUrl();
    if (base === window.location.origin) return undefined;
    const url = new URL(request.url);
    return new Request(`${base}${url.pathname}${url.search}`, request);
  },
};

/**
 * The single engine API client. Domain modules call `client.GET/POST/PATCH/
 * DELETE(path, ...)` with params/body checked against the generated contract.
 */
export const client = createClient<paths>({
  fetch: (request) => clientFetch(request),
});

client.use(baseUrlMiddleware);
