/**
 * Thin wrappers for the meeting-analysis job endpoints, on the generated
 * openapi-fetch client (fe-api-client-codegen, task 2.2).
 *
 * `submitMeeting`/`fetchJobStatus` throw on HTTP errors; the caller translates
 * thrown errors into UI state. The polling interval is enforced by
 * `pollUntilDone`.
 */

import { client } from "../api/client";
import type { components } from "../api/generated/openapi";
import type { JobStatusResponse } from "./types";

export interface SubmitOptions {
  enableWordTimestamps?: boolean;
  numSpeakers?: number;
  minSpeakers?: number;
  maxSpeakers?: number;
  language?: string;
  /**
   * Run ASR via the platform-default WhisperBackend (ggml+ANE on macOS,
   * ct2+CUDA on Linux) instead of WhisperX's CT2 batched ASR. ~3× faster
   * on Apple Silicon; word timestamps still available via
   * `enableWordTimestamps`. Backend default is false (existing slow path).
   */
  fast?: boolean;
  /**
   * Original filename of the uploaded audio. Used by the backend's
   * auto-persist path to populate the `meeting_analyses.filename`
   * column so the PWA history sidebar shows the file the user
   * uploaded, not a synthesised `meeting-<job_id>` placeholder.
   */
  filename?: string;
  /**
   * Diarization quality tier (v3 engine): "fast" (default, CAM++) or
   * "balanced" (larger embedding model, better speaker separation).
   * Only offered when /status meeting.quality_tiers includes it.
   */
  quality?: "fast" | "balanced";
}

/** Job descriptor returned by `POST /transcribe/meeting` — the generated
 *  contract type (`{ job_id, status_url }`). */
export type JobHandle = components["schemas"]["SubmitResponse"];

/** Serialize the structured meeting error surfaced to the user.
 *
 *  The meeting submit/poll/cancel routes return an ad-hoc
 *  `{ detail: { error, reason } }` body (an OBJECT — NOT the `{ detail: string }`
 *  `ApiErrorBody`). `openapi-fetch` has already parsed it into `error`, but its
 *  generated type for these routes is open/loose (the contract documents no
 *  error schema), so we preserve the whole structured payload rather than
 *  collapsing it to a string (design "Error responses"). */
function describeMeetingError(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

export async function submitMeeting(
  file: File,
  opts: SubmitOptions = {},
): Promise<JobHandle> {
  // The generated contract only documents `filename`/`quality`/`model` for this
  // route, but the engine also accepts the diarization/ASR tuning params below.
  // We build the full query and cast it so the request is byte-identical to the
  // pre-codegen one; openapi-fetch serializes every key regardless of the type.
  const query: Record<string, string> = {};
  if (opts.language) query.language = opts.language;
  if (opts.numSpeakers !== undefined)
    query.num_speakers = String(opts.numSpeakers);
  if (opts.minSpeakers !== undefined)
    query.min_speakers = String(opts.minSpeakers);
  if (opts.maxSpeakers !== undefined)
    query.max_speakers = String(opts.maxSpeakers);
  // Backend default is true. Only explicitly pass false so the URL stays
  // short and a future backend default change is honoured by clients that
  // haven't opted in.
  if (opts.enableWordTimestamps === false)
    query.enable_word_timestamps = "false";
  else if (opts.enableWordTimestamps === true)
    query.enable_word_timestamps = "true";
  // Same opt-in pattern as enableWordTimestamps: only send when true, so a
  // future backend default change to fast-on-everywhere is honoured.
  if (opts.fast === true) query.fast = "true";
  // Backend default is fast — only send the non-default tier.
  if (opts.quality === "balanced") query.quality = "balanced";
  if (opts.filename) query.filename = opts.filename;

  const { data, error, response } = await client.POST("/transcribe/meeting", {
    // Cast narrows our full query bag to the documented `filename`/`quality`/
    // `model` subset the generated type exposes; the extra engine-accepted keys
    // ride along (openapi-fetch serializes every key).
    params: { query: query as { filename?: string; quality?: string } },
    // MULTIPART/RAW ESCAPE HATCH (design "Binary and multipart request bodies"):
    // the contract types this request body as a byte array (`number[]`). We send
    // the raw File verbatim with its own Content-Type via an identity
    // `bodySerializer` + a narrow cast — openapi-fetch would otherwise
    // JSON-serialize it.
    body: file as unknown as number[],
    bodySerializer: (b) => b as unknown as File,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
  if (!response.ok || !data) {
    throw new Error(
      `Submit failed (${response.status}): ${describeMeetingError(error)}`,
    );
  }
  return data;
}

export async function fetchJobStatus(
  statusUrl: string,
): Promise<JobStatusResponse> {
  // `statusUrl` is `/transcribe/meeting/<job_id>` (from SubmitResponse.status_url
  // or built the same way from a job id); extract the id for the typed path.
  const id = statusUrl.split("/").pop() ?? "";
  const { data, error, response } = await client.GET(
    "/transcribe/meeting/{id}",
    { params: { path: { id } } },
  );
  if (!response.ok || !data) {
    throw new Error(
      `Poll failed (${response.status}): ${describeMeetingError(error)}`,
    );
  }
  // `result` is dynamic (`unknown`) in the contract; the narrowed
  // JobStatusResponse carries the concrete MeetingResult the renderer needs.
  return data as JobStatusResponse;
}

export async function pollUntilDone(
  statusUrl: string,
  onProgress: (status: JobStatusResponse) => void,
  intervalMs = 2000,
  signal?: AbortSignal,
): Promise<JobStatusResponse> {
  while (true) {
    if (signal?.aborted) {
      // Caller asked us to stop; surface a sentinel status so the caller
      // can decide what to do (typically: ignore and reset UI).
      const aborted: JobStatusResponse = {
        status: "cancelled",
        progress: 0,
        stage: "cancelled",
        result: null,
      };
      return aborted;
    }
    const status = await fetchJobStatus(statusUrl);
    onProgress(status);
    if (
      status.status === "done" ||
      status.status === "error" ||
      status.status === "cancelled"
    )
      return status;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function cancelMeeting(jobId: string): Promise<void> {
  // Fire-and-forget: any error is non-fatal. The UI has already reset.
  try {
    await client.DELETE("/transcribe/meeting/{id}", {
      params: { path: { id: jobId } },
    });
  } catch {
    // Network error during cancel — best-effort, silent.
  }
}
