/**
 * Meeting history store — backed by `/v1/meetings` (SQLite via
 * backend), not localStorage.
 *
 * Public API names (`loadHistory`, `recordHistory`, `updateHistory`,
 * `removeHistory`, `clearHistory`) are kept so call sites in
 * `meeting-page.ts` don't churn. Internally we:
 *
 *   1. Maintain a synchronous in-memory cache so `loadHistory()`
 *      stays sync (the renderer calls it on every refresh tick).
 *   2. Sync to the backend over HTTP via `meeting-history-api.ts`.
 *   3. One-shot migrate any pre-existing localStorage entries on
 *      first `prime()` call after this feature ships, then clear the
 *      localStorage key so we never re-migrate.
 *
 * Lifecycle: `prime()` runs once on PWA mount (awaited). After that
 * the cache is the source of truth for renders; mutations write
 * through to the backend AND update the cache.
 */

import {
  createMeeting,
  deleteMeeting,
  listMeetings,
  patchMeetingSpeakerNames,
  type MeetingFull,
} from "./meeting-history-api";
import type { MeetingResult } from "./types";

/** Legacy localStorage key — used only for the one-shot migration. */
const LEGACY_KEY = "whisper-wrap.meeting-history.v1";

/**
 * Public entry shape — preserved so meeting-page.ts call sites don't
 * change. New rows persist via MeetingFull-style fields; the optional
 * `result` carries the analyzer output (used by the renderer's
 * fast-path cache lookup).
 */
export interface HistoryEntry {
  job_id: string;
  filename: string;
  audio_duration_seconds: number | null;
  started_at: number;
  speakers?: number;
  status?: string;
  speaker_names?: Record<string, string>;
  result?: MeetingResult;
  /** Truthy when the server has the original audio file stored. The
   *  exact server path is in `audio_path`; the client only needs to
   *  know "is it there?" to decide whether to render the `<audio>`
   *  element with a /v1/meetings/{id}/audio src. */
  audio_path?: string | null;
  audio_mime_type?: string | null;
}

let cache: HistoryEntry[] = [];

function fromBackend(m: MeetingFull): HistoryEntry {
  return {
    job_id: m.id,
    filename: m.filename,
    audio_duration_seconds: m.duration_seconds,
    started_at: m.created_at,
    speakers: m.speakers_count ?? undefined,
    status: m.status,
    speaker_names: m.speaker_names,
    result: m.result,
    audio_path: m.audio_path,
    audio_mime_type: m.audio_mime_type,
  };
}

interface LegacyEntry {
  job_id?: string;
  filename?: string;
  audio_duration_seconds?: number | null;
  started_at?: number;
  speakers?: number;
  status?: string;
  speaker_names?: Record<string, string>;
  result?: MeetingResult;
}

function readLegacyLocalStorage(): LegacyEntry[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: unknown): e is LegacyEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as LegacyEntry).job_id === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Initial fetch from the backend + one-shot legacy migration. Idempotent:
 * once the legacy localStorage key is cleared, the migration block is
 * a no-op forever. Call once on PWA mount.
 */
export async function prime(): Promise<void> {
  try {
    const initial = await listMeetings({ limit: 100 });
    cache = initial.meetings.map(fromBackend);
  } catch {
    cache = [];
    return; // Backend unreachable — can't migrate either, so bail.
  }

  // Migration: only run when backend is empty AND localStorage has
  // legacy entries. This is the natural "first load after pulling
  // this change" state. If the user already has rows in the backend
  // (e.g. they used another device first), localStorage is just
  // dropped without overwriting backend state.
  if (cache.length === 0) {
    const legacy = readLegacyLocalStorage();
    if (legacy.length > 0) {
      for (const entry of legacy) {
        if (!entry.job_id || !entry.result) continue;
        try {
          await createMeeting({
            id: entry.job_id,
            filename: entry.filename ?? `meeting-${entry.job_id}`,
            result: entry.result,
            created_at: entry.started_at,
            duration_seconds: entry.audio_duration_seconds ?? null,
            language: entry.result.language ?? null,
            speakers_count: entry.speakers ?? null,
            speaker_names: entry.speaker_names ?? {},
            status: entry.status ?? "done",
          });
        } catch {
          // Per-entry failure (duplicate ID, malformed result) — skip.
        }
      }
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        // Private mode etc. — ignore.
      }
      // Refresh cache from backend so we reflect what landed.
      try {
        const refreshed = await listMeetings({ limit: 100 });
        cache = refreshed.meetings.map(fromBackend);
      } catch {
        // Keep whatever cache state we have.
      }
    }
  }
}

/** Synchronous read from the in-memory cache. Caller is expected to
 *  have awaited `prime()` already (idempotent re-prime is fine). */
export function loadHistory(): HistoryEntry[] {
  return [...cache];
}

/** Insert a brand-new entry. Persists to backend; updates the cache
 *  on success. Failures throw so the caller can surface them. */
export async function recordHistory(
  entry: HistoryEntry,
): Promise<HistoryEntry[]> {
  if (!entry.result) {
    // Legacy contract supported "record without result yet" (status
    // updated later). Backend rejects empty results, so we now defer
    // the row creation until the analysis completes (handled by the
    // worker's auto-persist on success).
    cache = [entry, ...cache.filter((e) => e.job_id !== entry.job_id)];
    return [...cache];
  }
  try {
    await createMeeting({
      id: entry.job_id,
      filename: entry.filename,
      result: entry.result,
      created_at: entry.started_at,
      duration_seconds: entry.audio_duration_seconds,
      language: entry.result.language ?? null,
      speakers_count: entry.speakers ?? null,
      speaker_names: entry.speaker_names ?? {},
      status: entry.status ?? "done",
    });
  } catch (e) {
    // The worker auto-persists too (see app/api/meeting.py
    // _persist_completed_job) so a 409 here just means the row
    // already exists — that's the happy path, not an error.
    const msg = (e as Error).message || "";
    if (!msg.includes("409")) throw e;
  }
  cache = [entry, ...cache.filter((e) => e.job_id !== entry.job_id)];
  return [...cache];
}

/** Patch an existing entry. Only `speaker_names` is server-writable;
 *  other fields are local-cache-only (used by the live job-tracking
 *  flow before backend persist lands). */
export async function updateHistory(
  jobId: string,
  patch: Partial<HistoryEntry>,
): Promise<HistoryEntry[]> {
  cache = cache.map((e) => (e.job_id === jobId ? { ...e, ...patch } : e));
  if (patch.speaker_names !== undefined) {
    try {
      await patchMeetingSpeakerNames(jobId, patch.speaker_names);
    } catch {
      // Best-effort: failure to persist rename doesn't break the UI.
      // Local cache still carries the renamed labels; next reload
      // will re-fetch from backend without the rename.
    }
  }
  return [...cache];
}

/** Remove an entry. Backend DELETE + cache removal. */
export async function removeHistory(jobId: string): Promise<HistoryEntry[]> {
  try {
    await deleteMeeting(jobId);
  } catch {
    // Even on failure, drop from cache — the entry is unloadable.
  }
  cache = cache.filter((e) => e.job_id !== jobId);
  return [...cache];
}

export function clearHistory(): void {
  cache = [];
}

/** Test-only: force-set the cache to a known state. Not exported in
 *  production builds (no tree-shake guard, but no caller uses it). */
export function _setCacheForTests(entries: HistoryEntry[]): void {
  cache = entries;
}
