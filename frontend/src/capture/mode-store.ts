/**
 * Persists the active capture mode (Live vs Batch) to localStorage.
 *
 * Default is "batch" — short voice memos with a single transcription on stop
 * are the most common use case; live captioning is opt-in.
 */

export type CaptureMode = "batch" | "live";

export const CAPTURE_MODE_KEY = "whisper-wrap.captureMode";
export const DEFAULT_CAPTURE_MODE: CaptureMode = "batch";

export function loadCaptureMode(): CaptureMode {
  const raw = window.localStorage.getItem(CAPTURE_MODE_KEY);
  return raw === "live" || raw === "batch" ? raw : DEFAULT_CAPTURE_MODE;
}

export function saveCaptureMode(mode: CaptureMode): void {
  window.localStorage.setItem(CAPTURE_MODE_KEY, mode);
}
