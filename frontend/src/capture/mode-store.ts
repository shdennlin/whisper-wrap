/**
 * Persists whether live captions are enabled (fe-recording-modes).
 *
 * The old model had two exclusive capture modes (Batch vs Live); the new model
 * is one capture session with a "live captions" toggle, so the only persisted
 * state is a boolean. Default is false (live off) — short voice memos with a
 * single transcription on stop are the common case; live captioning is opt-in.
 *
 * Migration: the legacy `whisper-wrap.captureMode` key ("batch"|"live") is read
 * once as a fallback when the new key is absent ("live" → true, else false).
 * The legacy key is intentionally left intact for one release so reverting the
 * frontend keeps the old behavior.
 */

export const LIVE_CAPTIONS_KEY = "whisper-wrap.liveCaptions";
export const LEGACY_CAPTURE_MODE_KEY = "whisper-wrap.captureMode";
export const DEFAULT_LIVE_CAPTIONS = false;

export function loadLiveCaptions(): boolean {
  const raw = window.localStorage.getItem(LIVE_CAPTIONS_KEY);
  if (raw === "true") return true;
  if (raw === "false") return false;
  // No explicit choice yet — migrate from the legacy exclusive mode.
  const legacy = window.localStorage.getItem(LEGACY_CAPTURE_MODE_KEY);
  return legacy === "live";
}

export function saveLiveCaptions(on: boolean): void {
  window.localStorage.setItem(LIVE_CAPTIONS_KEY, String(on));
}
