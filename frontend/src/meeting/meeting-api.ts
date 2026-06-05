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
  if (opts.enableWordTimestamps === false)
    params.set("enable_word_timestamps", "false");

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
): Promise<JobStatusResponse> {
  while (true) {
    const status = await fetchJobStatus(statusUrl);
    onProgress(status);
    if (status.status === "done" || status.status === "error") return status;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
