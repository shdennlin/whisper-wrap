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

export async function deleteMeeting(id: string): Promise<void> {
  const r = await fetch(`/v1/meetings/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!r.ok && r.status !== 404) {
    throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  }
}
