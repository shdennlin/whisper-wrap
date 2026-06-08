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
  // Same opt-in pattern as enableWordTimestamps: only send when true, so a
  // future backend default change to fast-on-everywhere is honoured.
  if (opts.fast === true) params.set("fast", "true");
  if (opts.filename) params.set("filename", opts.filename);

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
