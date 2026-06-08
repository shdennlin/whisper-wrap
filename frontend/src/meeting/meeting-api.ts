/**
 * Thin fetch wrappers for the meeting analysis endpoints.
 *
 * Both functions throw on HTTP errors; the caller is responsible for
 * translating thrown errors into UI state. The polling interval is enforced
 * by `pollUntilDone`.
 */

import type { JobStatusResponse } from "./types";

export interface SubmitOptions {
  enableWordTimestamps?: boolean;
  numSpeakers?: number;
  minSpeakers?: number;
  maxSpeakers?: number;
  language?: string;
}

export interface JobHandle {
  job_id: string;
  status_url: string;
}

export async function submitMeeting(
  file: File,
  opts: SubmitOptions = {},
): Promise<JobHandle> {
  const params = new URLSearchParams();
  if (opts.language) params.set("language", opts.language);
  if (opts.numSpeakers !== undefined)
    params.set("num_speakers", String(opts.numSpeakers));
  if (opts.minSpeakers !== undefined)
    params.set("min_speakers", String(opts.minSpeakers));
  if (opts.maxSpeakers !== undefined)
    params.set("max_speakers", String(opts.maxSpeakers));
  // Backend default is true. Only explicitly pass false so the URL stays
  // short and a future backend default change is honoured by clients that
  // haven't opted in.
  if (opts.enableWordTimestamps === false)
    params.set("enable_word_timestamps", "false");
  else if (opts.enableWordTimestamps === true)
    params.set("enable_word_timestamps", "true");

  const url = `/transcribe/meeting${params.toString() ? `?${params}` : ""}`;
  const resp = await fetch(url, {
    method: "POST",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
  if (!resp.ok) {
    throw new Error(`Submit failed (${resp.status}): ${await resp.text()}`);
  }
  return resp.json();
}

export async function fetchJobStatus(
  statusUrl: string,
): Promise<JobStatusResponse> {
  const resp = await fetch(statusUrl);
  if (!resp.ok) {
    throw new Error(`Poll failed (${resp.status}): ${await resp.text()}`);
  }
  return resp.json();
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
    await fetch(`/transcribe/meeting/${jobId}`, { method: "DELETE" });
  } catch {
    // Network error during cancel — best-effort, silent.
  }
}
