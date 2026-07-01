/**
 * HTTP client for /v1/meetings, on the generated openapi-fetch client
 * (fe-api-client-codegen, task 2.2).
 *
 * Backs `history-store.ts` since we moved meeting history off localStorage and
 * onto the backend SQLite. Every function returns the parsed JSON body or
 * throws an Error carrying the response status + detail; the caller decides how
 * to translate failures into UI state. Requests route through the shared
 * `client` (path/params/response typed against the generated contract, base URL
 * + auth handled by the client middleware).
 */

import { client } from "../api/client";
import type { components } from "../api/generated/openapi";
import type { MeetingResult } from "./types";

/**
 * A meeting row. The static columns come straight from the generated contract
 * (`components["schemas"]["MeetingFull"]`); the fields the engine keeps as a
 * dynamic `serde_json::Value` — `result` and `speaker_names` — plus the
 * always-present `duration_seconds` are narrowed here to the concrete frontend
 * shapes the store/renderer rely on. This is the meeting analog of the
 * documented dynamic-field exception (design "Cast only the documented dynamic
 * exceptions"): the generated `MeetingFull` types `result`/`speaker_names` as
 * `unknown` and `duration_seconds` as optional.
 */
export type MeetingFull = Omit<
  components["schemas"]["MeetingFull"],
  "result" | "speaker_names" | "duration_seconds"
> & {
  duration_seconds: number | null;
  result: MeetingResult;
  speaker_names: Record<string, string>;
};

/** New-meeting request body — the generated contract type. */
export type MeetingCreateBody = components["schemas"]["MeetingCreate"];

/** Sidecar-audio upload response — the generated contract type. */
export type MeetingAudioMeta = components["schemas"]["AudioUploadResponse"];

/** Reconstruct the `HTTP <status>: <detail>` error the pre-codegen `ok()`
 *  helper threw. `openapi-fetch` has already parsed the error body into
 *  `error` (object for JSON, string otherwise); serialize it so the surfaced
 *  message keeps whatever detail the engine sent. */
function fail(status: number, error: unknown): never {
  const detail =
    error == null
      ? ""
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  throw new Error(`HTTP ${status}: ${detail}`);
}

export async function listMeetings(opts?: {
  limit?: number;
  before_ms?: number;
}): Promise<{ meetings: MeetingFull[]; next_before_ms: number | null }> {
  const query: { limit?: number; before_ms?: number } = {};
  if (opts?.limit !== undefined) query.limit = opts.limit;
  if (opts?.before_ms !== undefined) query.before_ms = opts.before_ms;
  const { data, error, response } = await client.GET("/v1/meetings", {
    params: { query },
  });
  if (!response.ok || !data) fail(response.status, error);
  // `result`/`speaker_names` are dynamic `unknown` in the contract; narrow the
  // list rows to the frontend meeting shape the store consumes.
  return {
    meetings: data.meetings as MeetingFull[],
    next_before_ms: data.next_before_ms ?? null,
  };
}

export async function getMeeting(id: string): Promise<MeetingFull | null> {
  const { data, error, response } = await client.GET("/v1/meetings/{id}", {
    params: { path: { id } },
  });
  if (response.status === 404) return null;
  if (!response.ok || !data) fail(response.status, error);
  return data as MeetingFull;
}

export async function createMeeting(
  body: MeetingCreateBody,
): Promise<MeetingFull> {
  const { data, error, response } = await client.POST("/v1/meetings", { body });
  if (!response.ok || !data) fail(response.status, error);
  return data as MeetingFull;
}

export async function patchMeetingSpeakerNames(
  id: string,
  speakerNames: Record<string, string>,
): Promise<MeetingFull> {
  const { data, error, response } = await client.PATCH("/v1/meetings/{id}", {
    params: { path: { id } },
    body: { speaker_names: speakerNames },
  });
  if (!response.ok || !data) fail(response.status, error);
  return data as MeetingFull;
}

/** Rename a meeting (its display title in the sidebar + page header).
 *  Backend strips whitespace and rejects empty. */
export async function patchMeetingFilename(
  id: string,
  filename: string,
): Promise<MeetingFull> {
  const { data, error, response } = await client.PATCH("/v1/meetings/{id}", {
    params: { path: { id } },
    body: { filename },
  });
  if (!response.ok || !data) fail(response.status, error);
  return data as MeetingFull;
}

/** PATCH a meeting's item metadata (item-metadata): title/starred/project/category. */
export async function patchMeetingMeta(
  id: string,
  body: Partial<{
    title: string;
    starred: boolean;
    project: string;
    category: string;
  }>,
): Promise<MeetingFull> {
  const { data, error, response } = await client.PATCH("/v1/meetings/{id}", {
    params: { path: { id } },
    body,
  });
  if (!response.ok || !data) fail(response.status, error);
  return data as MeetingFull;
}

export async function deleteMeeting(id: string): Promise<void> {
  const { error, response } = await client.DELETE("/v1/meetings/{id}", {
    params: { path: { id } },
  });
  // 404 is tolerated (idempotent delete); any other non-OK throws.
  if (!response.ok && response.status !== 404) {
    fail(response.status, error);
  }
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
  // Content-Type per multipart part. DON'T set a manual Content-Type; the
  // browser MUST generate `multipart/form-data` with a boundary itself.
  form.append("file", new Blob([blob], { type: mimeType }), "audio");
  const { data, error, response } = await client.POST(
    "/v1/meetings/{id}/audio",
    {
      params: { path: { id } },
      // MULTIPART ESCAPE HATCH (design "Binary and multipart request bodies"):
      // the contract types this request body as a byte array (`number[]`) and
      // openapi-fetch JSON-serializes bodies by default, so we pass an identity
      // `bodySerializer` that hands the FormData straight through (letting the
      // browser set the multipart boundary) plus a narrow cast of `body` to the
      // generated request type.
      body: form as unknown as number[],
      bodySerializer: (b) => b as unknown as FormData,
    },
  );
  if (!response.ok || !data) fail(response.status, error);
  return data;
}

/** Returns the audio URL to set as `<audio src>` (we use the
 *  endpoint URL directly so the browser streams without buffering
 *  the entire blob in memory). Callers check `meeting.audio_path`
 *  first — null means no audio uploaded yet, in which case this
 *  endpoint would 404. */
export function meetingAudioUrl(id: string): string {
  return `/v1/meetings/${encodeURIComponent(id)}/audio`;
}
