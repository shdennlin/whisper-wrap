/**
 * One-shot import of legacy browser-stored history into the backend.
 *
 * Walks `localStorage["whisper-wrap.sessions"]` (the pre-2.3 schema), POSTs
 * every session + its finals + its runs to the new `/v1/sessions` API, then
 * clears the localStorage key on full success. Partial failure preserves
 * the local store so the user can retry.
 *
 * Audio blobs from the old IndexedDB `whisper-wrap-audio` store are NOT
 * migrated by this routine — AudioStore is gone from the runtime so the
 * blobs are unreachable from current code. They remain harmlessly in the
 * user's browser storage until the browser evicts them.
 *
 * The 409 path is treated as "already imported" — useful when retrying
 * after a partial failure mid-batch left some sessions written to the
 * backend.
 */

import {
  createSession,
  appendFinalToApi,
  appendActionRunToApi,
  HistoryApiError,
} from "../storage/history-api-client";
import { STORAGE_KEY } from "../storage/history-store";

interface LegacySessionFinal {
  text: string;
  start_ms: number;
  end_ms: number;
  kind?: string;
}

interface LegacyActionRun {
  action_id: string;
  prompt: string;
  answer: string;
  ran_at: number;
}

interface LegacySession {
  id: string;
  started_at: number;
  ended_at: number | null;
  finals: LegacySessionFinal[];
  action_runs: LegacyActionRun[];
}

interface LegacyState {
  version: number;
  sessions: LegacySession[];
  retention?: number;
}

export interface ImportLegacyResult {
  sessionsImported: number;
  finalsImported: number;
  runsImported: number;
  errors: { sessionId: string; reason: string }[];
}

export interface ImportLegacyDeps {
  backendUrl: () => string;
  /** Optional override for tests; defaults to reading window.localStorage. */
  readLocalStorage?: () => string | null;
  /** Optional override for tests; defaults to window.localStorage.removeItem. */
  clearLocalStorage?: () => void;
}

export function hasLegacyData(): boolean {
  if (typeof window === "undefined") return false;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Partial<LegacyState>;
    return Array.isArray(parsed?.sessions) && parsed.sessions.length > 0;
  } catch {
    return false;
  }
}

export async function importLegacyData(
  deps: ImportLegacyDeps,
): Promise<ImportLegacyResult> {
  const read = deps.readLocalStorage ?? (() => window.localStorage.getItem(STORAGE_KEY));
  const clear = deps.clearLocalStorage ?? (() => window.localStorage.removeItem(STORAGE_KEY));

  const result: ImportLegacyResult = {
    sessionsImported: 0,
    finalsImported: 0,
    runsImported: 0,
    errors: [],
  };

  const raw = read();
  if (!raw) return result;

  let state: LegacyState;
  try {
    state = JSON.parse(raw) as LegacyState;
  } catch (e) {
    result.errors.push({
      sessionId: "<root>",
      reason: `failed to parse legacy state: ${e instanceof Error ? e.message : String(e)}`,
    });
    return result;
  }

  if (!Array.isArray(state.sessions) || state.sessions.length === 0) {
    return result;
  }

  const url = deps.backendUrl();
  for (const session of state.sessions) {
    try {
      await importOneSession(url, session);
      result.sessionsImported += 1;
      result.finalsImported += session.finals.length;
      result.runsImported += session.action_runs.length;
    } catch (e) {
      result.errors.push({
        sessionId: session.id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Only clear local storage when no errors were recorded so the user can
  // retry without losing data.
  if (result.errors.length === 0) {
    clear();
  }

  return result;
}

async function importOneSession(
  backendUrl: string,
  session: LegacySession,
): Promise<void> {
  const mode = session.id.length > 0 && session.id.startsWith("live-") ? "live" : "batch";
  try {
    await createSession(backendUrl, {
      id: session.id,
      started_at: session.started_at,
      mode,
    });
  } catch (e) {
    if (e instanceof HistoryApiError && e.status === 409) {
      // Already imported during a prior run — skip create but proceed to
      // finals/runs which are append-only so duplicates would compound.
      // We don't have a "skip if exists" check at row level; the safest
      // path is to bail entirely on 409 since the previous import already
      // moved everything for this session.
      return;
    }
    throw e;
  }

  for (const f of session.finals) {
    await appendFinalToApi(backendUrl, session.id, {
      text: f.text,
      start_ms: f.start_ms,
      end_ms: f.end_ms,
      kind: f.kind ?? null,
    });
  }
  for (const r of session.action_runs) {
    await appendActionRunToApi(backendUrl, session.id, {
      action_id: r.action_id,
      prompt: r.prompt,
      answer: r.answer,
      ran_at: r.ran_at,
    });
  }
}
