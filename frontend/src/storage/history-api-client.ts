/**
 * Thin wrappers around the backend `/v1/sessions` REST API.
 *
 * These call the single generated `openapi-fetch` client
 * (fe-api-client-codegen, task 2.1). The base URL is no longer threaded
 * through a `backendUrl` first-arg — the client's request middleware injects
 * it from the canonical `backendUrl()` per call, so every function takes only
 * its endpoint inputs. Path/params/request-body/response are checked at build
 * time against the generated contract; each function throws `HistoryApiError`
 * on a non-2xx response so the HistoryStore's existing failure handling is
 * unchanged.
 *
 * Intentionally NO retry / caching / batching. That's the HistoryStore's
 * job — this module is just the HTTP transport layer.
 */

import { client } from "../api/client";
import type { components } from "../api/generated/openapi";
import { backendUrl } from "../api/backend-url";
import type { SessionFinal, SessionRecord } from "./history-store";

export type CaptureMode = "batch" | "live";

/**
 * Full session detail as returned by `GET/POST/PATCH /v1/sessions(/{id})`.
 * The generated contract now owns this shape (was a hand-written
 * `SessionDigest`/`SessionFull` pair); re-exported under the same name so
 * consumers (`detail-view.ts`, `items.ts`) keep importing it from here.
 */
export type SessionFull = components["schemas"]["SessionFull"];

/**
 * Shape consumed by HistoryPanel's `getAudio` callback. Mirrors the old
 * IndexedDB record so consumers don't need to change. `duration_ms` SHALL
 * be populated by the caller (main.ts looks it up from the session cache)
 * so the waveform player can size its time axis and drag-to-scrub math.
 *
 * NOT a wire type — the contract does not model it, so it stays hand-written.
 */
export interface StoredAudio {
  session_id: string;
  mime_type: string;
  blob: Blob;
  duration_ms: number;
  byte_size: number;
  stored_at: number;
}

export class HistoryApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Build a `HistoryApiError` from openapi-fetch's `{ error, response }`.
 *  Sessions errors are all `ApiErrorBody` (`{detail:string}`) — surface the
 *  detail like the old `ensureOk` did, falling back to the status text. */
function apiError(
  error: components["schemas"]["ApiErrorBody"] | undefined,
  response: Response,
): HistoryApiError {
  const detail = error?.detail ?? "";
  return new HistoryApiError(
    `HTTP ${response.status} ${detail || response.statusText}`,
    response.status,
  );
}

export async function listSessions(
  opts: { limit?: number; before_ms?: number } = {},
): Promise<components["schemas"]["SessionListResponse"]> {
  const query: { limit?: number; before_ms?: number } = {};
  if (opts.limit !== undefined) query.limit = opts.limit;
  if (opts.before_ms !== undefined) query.before_ms = opts.before_ms;
  const { data, error, response } = await client.GET("/v1/sessions", {
    params: { query },
  });
  if (error) throw apiError(error, response);
  return data;
}

export async function getSession(sessionId: string): Promise<SessionFull | null> {
  const { data, error, response } = await client.GET("/v1/sessions/{id}", {
    params: { path: { id: sessionId } },
  });
  if (response.status === 404) return null;
  if (error) throw apiError(error, response);
  return data;
}

export async function createSession(
  body: { id: string; started_at: number; mode: CaptureMode },
): Promise<SessionFull> {
  const { data, error, response } = await client.POST("/v1/sessions", { body });
  if (error) throw apiError(error, response);
  return data;
}

export async function patchSession(
  sessionId: string,
  body: components["schemas"]["SessionPatch"],
): Promise<SessionFull> {
  const { data, error, response } = await client.PATCH("/v1/sessions/{id}", {
    params: { path: { id: sessionId } },
    body,
  });
  if (error) throw apiError(error, response);
  return data;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const { error, response } = await client.DELETE("/v1/sessions/{id}", {
    params: { path: { id: sessionId } },
  });
  if (response.status === 404) return; // idempotent delete
  if (error) throw apiError(error, response);
}

export async function appendFinalToApi(
  sessionId: string,
  body: SessionFinal & { kind?: string | null },
): Promise<void> {
  const { error, response } = await client.POST("/v1/sessions/{id}/finals", {
    params: { path: { id: sessionId } },
    body,
  });
  if (error) throw apiError(error, response);
}

export async function uploadAudio(
  sessionId: string,
  blob: Blob,
  mimeType: string,
): Promise<components["schemas"]["AudioUploadResponse"]> {
  const form = new FormData();
  form.append("file", new Blob([blob], { type: mimeType }), `audio${extFromMime(mimeType)}`);
  const { data, error, response } = await client.POST("/v1/sessions/{id}/audio", {
    params: { path: { id: sessionId } },
    // Multipart escape hatch (design "Binary and multipart request bodies
    // need a bodySerializer + a body-type cast"): the contract types this
    // request body as a byte array (`number[]`) and openapi-fetch would
    // JSON-serialize it. We instead send the `FormData` verbatim via an
    // identity `bodySerializer` so the browser sets the multipart boundary,
    // and cast `body` to the generated `number[]` request type. This is a
    // request-body escape hatch only; it does not weaken response typing.
    body: form as unknown as number[],
    bodySerializer: () => form,
  });
  if (error) throw apiError(error, response);
  return data;
}

export async function getAudio(
  sessionId: string,
): Promise<{ blob: Blob; mime_type: string } | null> {
  // Binary stream — stays on native `fetch` (design "binary engine calls
  // stay off the generated JSON client"). Base URL still collapses onto the
  // canonical `backendUrl()` so no per-call threading remains.
  const r = await fetch(`${backendUrl()}/v1/sessions/${sessionId}/audio`);
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new HistoryApiError(`HTTP ${r.status} ${r.statusText}`, r.status);
  }
  const mime = r.headers.get("content-type") || "application/octet-stream";
  const blob = await r.blob();
  return { blob, mime_type: mime };
}

export async function bulkClearAudio(): Promise<
  components["schemas"]["BulkClearAudioResponse"]
> {
  const { data, error, response } = await client.DELETE("/v1/sessions/audio");
  if (error) throw apiError(error, response);
  return data;
}

function extFromMime(mime: string): string {
  switch (mime) {
    case "audio/webm":
      return ".webm";
    case "audio/mp4":
      return ".m4a";
    case "audio/ogg":
      return ".ogg";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return ".wav";
    default:
      return ".bin";
  }
}

/** Re-export to keep type continuity for consumers. */
export type { SessionRecord };
