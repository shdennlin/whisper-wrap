/**
 * localStorage-backed list of recent meeting analyses.
 *
 * Stores the last N job_ids the user submitted, with enough metadata to
 * render a list entry (filename, duration, started timestamp) without
 * re-fetching from the server. The result itself stays on the server until
 * its TTL evicts it — clicking a history entry triggers a GET to fetch the
 * full result.
 *
 * Schema is forward-compatible: unknown extra fields are kept, missing
 * fields are tolerated, version changes are detected via the wrapping shape.
 */

import type { MeetingResult } from "./types";

const STORAGE_KEY = "whisper-wrap.meeting-history.v1";
const MAX_ENTRIES = 20;

export interface HistoryEntry {
  job_id: string;
  filename: string;
  audio_duration_seconds: number | null;
  started_at: number; // unix ms
  /** Set once the job completes successfully; lets the sidebar show speaker count. */
  speakers?: number;
  /** "done" | "cancelled" | "error" | "running"; tracks last known state. */
  status?: string;
  /** User-renamed speaker labels: SPEAKER_xx → friendly name. Empty/absent
   *  means use the raw pyannote labels. Persisted so reloading a past
   *  analysis from the sidebar still shows "Alice" not "SPEAKER_00". */
  speaker_names?: Record<string, string>;
  /** Full MeetingResult, persisted so the user can re-open a past
   *  analysis even AFTER the backend has evicted the job from its
   *  in-memory store (default TTL: 1 hour). Without this the sidebar
   *  item would just 404 once an hour passed, which is bad UX for what
   *  is otherwise a permanent history list.
   *
   *  Storage cost: ~50-200KB per result for typical meetings; with
   *  MAX_ENTRIES=20 we cap at ~4MB worst case, well under the
   *  ~5-10MB localStorage budget. */
  result?: MeetingResult;
}

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is HistoryEntry =>
        typeof e?.job_id === "string" && typeof e?.filename === "string",
    );
  } catch {
    // Corrupted JSON or quota-related getItem failure — start fresh rather
    // than throw, so a busted entry doesn't permanently disable history.
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded / private mode — silent. The UI keeps working;
    // history just won't persist this session.
  }
}

/** Prepend a new entry. Caps at MAX_ENTRIES, oldest dropped first. */
export function recordHistory(entry: HistoryEntry): HistoryEntry[] {
  const existing = loadHistory().filter((e) => e.job_id !== entry.job_id);
  const next = [entry, ...existing].slice(0, MAX_ENTRIES);
  saveHistory(next);
  return next;
}

/** Patch an entry in-place by job_id. No-op if the job_id is unknown. */
export function updateHistory(
  jobId: string,
  patch: Partial<HistoryEntry>,
): HistoryEntry[] {
  const next = loadHistory().map((e) =>
    e.job_id === jobId ? { ...e, ...patch } : e,
  );
  saveHistory(next);
  return next;
}

/** Remove an entry — used when GET returns 404 (server-side TTL evicted). */
export function removeHistory(jobId: string): HistoryEntry[] {
  const next = loadHistory().filter((e) => e.job_id !== jobId);
  saveHistory(next);
  return next;
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}
