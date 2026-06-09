/**
 * HTTP client for /v1/meetings.
 *
 * Backs `history-store.ts` since we moved meeting history off
 * localStorage and onto the backend SQLite. Every function returns
 * the parsed JSON body or throws an Error carrying the response text;
 * the caller decides how to translate failures into UI state.
 */

import type { MeetingResult } from "./types";

export interface MeetingFull {
  id: string;
  created_at: number;
  filename: string;
  duration_seconds: number | null;
  language: string | null;
  speakers_count: number | null;
  result: MeetingResult;
  speaker_names: Record<string, string>;
  status: string;
  // Audio metadata — null until the original recording is uploaded
  // via POST /v1/meetings/{id}/audio.
  audio_path?: string | null;
  audio_mime_type?: string | null;
  audio_size_bytes?: number | null;
}

export interface MeetingListResponse {
  meetings: MeetingFull[];
  next_before_ms: number | null;
}

export interface MeetingCreateBody {
  id: string;
  filename: string;
  result: MeetingResult;
  created_at?: number;
  duration_seconds?: number | null;
  language?: string | null;
  speakers_count?: number | null;
  speaker_names?: Record<string, string>;
  status?: string;
}

async function ok<T>(r: Response): Promise<T> {
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as T;
}

export async function listMeetings(opts?: {
  limit?: number;
  before_ms?: number;
}): Promise<MeetingListResponse> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.before_ms !== undefined)
    params.set("before_ms", String(opts.before_ms));
  const url = `/v1/meetings${params.toString() ? `?${params}` : ""}`;
  return ok<MeetingListResponse>(await fetch(url));
}

export async function getMeeting(id: string): Promise<MeetingFull | null> {
  const r = await fetch(`/v1/meetings/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  return ok<MeetingFull>(r);
}

export async function createMeeting(
  body: MeetingCreateBody,
): Promise<MeetingFull> {
  const r = await fetch("/v1/meetings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return ok<MeetingFull>(r);
}

export async function patchMeetingSpeakerNames(
  id: string,
  speakerNames: Record<string, string>,
): Promise<MeetingFull> {
  const r = await fetch(`/v1/meetings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ speaker_names: speakerNames }),
  });
  return ok<MeetingFull>(r);
}

/** Rename a meeting (its display title in the sidebar + page header).
 *  Backend strips whitespace and rejects empty. */
export async function patchMeetingFilename(
  id: string,
  filename: string,
): Promise<MeetingFull> {
  const r = await fetch(`/v1/meetings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename }),
  });
  return ok<MeetingFull>(r);
}

export async function deleteMeeting(id: string): Promise<void> {
  const r = await fetch(`/v1/meetings/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!r.ok && r.status !== 404) {
    throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  }
}

export interface MeetingAudioMeta {
  audio_path: string;
  audio_mime_type: string;
  audio_size_bytes: number;
}

/** Upload the original recording as a sidecar to a finished meeting
 *  analysis. Multipart form (`file` field) mirrors /v1/sessions/{id}
 *  /audio. Best-effort from the caller's perspective: failures are
 *  non-fatal; the analysis row still exists, just without audio. */
export async function uploadMeetingAudio(
  id: string,
  blob: Blob,
  mimeType: string,
): Promise<MeetingAudioMeta> {
  const form = new FormData();
  // Wrap in a Blob carrying the mime so the server sees the right
  // Content-Type per multipart part. DON'T set a manual fetch header;
  // the browser MUST generate Content-Type: multipart/form-data with
  // a boundary itself.
  form.append("file", new Blob([blob], { type: mimeType }), "audio");
  const r = await fetch(`/v1/meetings/${encodeURIComponent(id)}/audio`, {
    method: "POST",
    body: form,
  });
  return ok<MeetingAudioMeta>(r);
}

/** Returns the audio URL to set as `<audio src>` (we use the
 *  endpoint URL directly so the browser streams without buffering
 *  the entire blob in memory). Callers check `meeting.audio_path`
 *  first — null means no audio uploaded yet, in which case this
 *  endpoint would 404. */
export function meetingAudioUrl(id: string): string {
  return `/v1/meetings/${encodeURIComponent(id)}/audio`;
}
