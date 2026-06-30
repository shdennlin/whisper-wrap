/**
 * Thin fetch wrappers around the backend `/v1/sessions` REST API.
 *
 * Each function takes `backendUrl` first (so callers can pin against
 * `loadSettings().backendUrl` without smuggling it through closures), the
 * endpoint inputs second, returns the typed response or throws on non-2xx.
 *
 * Intentionally NO retry / caching / batching. That's the HistoryStore's
 * job — this module is just the HTTP transport layer.
 */

import type { SessionFinal, SessionRecord } from "./history-store";

export type CaptureMode = "batch" | "live";

export interface SessionDigest {
  id: string;
  started_at: number;
  ended_at: number | null;
  mode: CaptureMode;
  audio_path: string | null;
  audio_mime_type: string | null;
  audio_size_bytes: number | null;
  duration_ms: number | null;
  // Item metadata (item-metadata backend). Optional so older/partial responses
  // still typecheck; the backend returns them on current rows.
  title?: string | null;
  starred?: boolean;
  project?: string | null;
  category?: string | null;
}

export interface SessionFull extends SessionDigest {
  finals: { session_id: string; ord: number; text: string; start_ms: number | null; end_ms: number | null; kind: string | null }[];
  action_runs: { id: number; session_id: string; action_id: string; prompt: string; answer: string; ran_at: number; model_used: string | null; succeeded: boolean }[];
}

export interface SessionListResponse {
  // GET /v1/sessions returns full sessions (finals + action_runs eagerly
  // loaded) so list rows can render previews and char counts on first paint.
  sessions: SessionFull[];
  next_before_ms: number | null;
}

export interface AudioMeta {
  audio_path: string;
  audio_size_bytes: number;
  audio_mime_type: string;
}

/**
 * Shape consumed by HistoryPanel's `getAudio` callback. Mirrors the old
 * IndexedDB record so consumers don't need to change. `duration_ms` SHALL
 * be populated by the caller (main.ts looks it up from the session cache)
 * so the waveform player can size its time axis and drag-to-scrub math.
 */
export interface StoredAudio {
  session_id: string;
  mime_type: string;
  blob: Blob;
  duration_ms: number;
  byte_size: number;
  stored_at: number;
}

export interface BulkAudioClearResponse {
  deleted_count: number;
}

export class HistoryApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function url(backendUrl: string, path: string): string {
  return `${backendUrl.replace(/\/$/, "")}${path}`;
}

async function ensureOk(r: Response): Promise<Response> {
  if (!r.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await r.clone().json());
    } catch {
      detail = await r.clone().text();
    }
    throw new HistoryApiError(
      `HTTP ${r.status} ${detail || r.statusText}`,
      r.status,
    );
  }
  return r;
}

export async function listSessions(
  backendUrl: string,
  opts: { limit?: number; before_ms?: number } = {},
): Promise<SessionListResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.before_ms !== undefined)
    params.set("before_ms", String(opts.before_ms));
  const qs = params.toString();
  const r = await fetch(url(backendUrl, `/v1/sessions${qs ? `?${qs}` : ""}`));
  await ensureOk(r);
  return r.json();
}

export async function getSession(
  backendUrl: string,
  sessionId: string,
): Promise<SessionFull | null> {
  const r = await fetch(url(backendUrl, `/v1/sessions/${sessionId}`));
  if (r.status === 404) return null;
  await ensureOk(r);
  return r.json();
}

export async function createSession(
  backendUrl: string,
  body: { id: string; started_at: number; mode: CaptureMode },
): Promise<SessionFull> {
  const r = await fetch(url(backendUrl, "/v1/sessions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await ensureOk(r);
  return r.json();
}

export async function patchSession(
  backendUrl: string,
  sessionId: string,
  body: Partial<{
    ended_at: number;
    duration_ms: number;
    audio_path: string;
    audio_mime_type: string;
    audio_size_bytes: number;
    // Item metadata (item-metadata): renamable / starrable / organisable.
    title: string;
    starred: boolean;
    project: string;
    category: string;
  }>,
): Promise<SessionFull> {
  const r = await fetch(url(backendUrl, `/v1/sessions/${sessionId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await ensureOk(r);
  return r.json();
}

export async function deleteSession(
  backendUrl: string,
  sessionId: string,
): Promise<void> {
  const r = await fetch(url(backendUrl, `/v1/sessions/${sessionId}`), {
    method: "DELETE",
  });
  if (r.status === 404) return; // idempotent delete
  await ensureOk(r);
}

export async function appendFinalToApi(
  backendUrl: string,
  sessionId: string,
  body: SessionFinal & { kind?: string | null },
): Promise<void> {
  const r = await fetch(url(backendUrl, `/v1/sessions/${sessionId}/finals`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await ensureOk(r);
}

export async function uploadAudio(
  backendUrl: string,
  sessionId: string,
  blob: Blob,
  mimeType: string,
): Promise<AudioMeta> {
  const form = new FormData();
  form.append("file", new Blob([blob], { type: mimeType }), `audio${extFromMime(mimeType)}`);
  const r = await fetch(url(backendUrl, `/v1/sessions/${sessionId}/audio`), {
    method: "POST",
    body: form,
  });
  await ensureOk(r);
  return r.json();
}

export async function getAudio(
  backendUrl: string,
  sessionId: string,
): Promise<{ blob: Blob; mime_type: string } | null> {
  const r = await fetch(url(backendUrl, `/v1/sessions/${sessionId}/audio`));
  if (r.status === 404) return null;
  await ensureOk(r);
  const mime = r.headers.get("content-type") || "application/octet-stream";
  const blob = await r.blob();
  return { blob, mime_type: mime };
}

export async function bulkClearAudio(
  backendUrl: string,
): Promise<BulkAudioClearResponse> {
  const r = await fetch(url(backendUrl, `/v1/sessions/audio`), {
    method: "DELETE",
  });
  await ensureOk(r);
  return r.json();
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
