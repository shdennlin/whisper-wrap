/**
 * Per-session capture history backed by the `/v1/sessions` REST API.
 *
 * Reads (`list`, `get`) hit the in-memory cache and resolve synchronously
 * after `prime()` has run once at startup. Writes (`startSession`,
 * `appendFinal`, ...) issue API calls and update the cache only on 2xx so
 * a failed network call doesn't pollute the optimistic view.
 *
 * `startSession` is intentionally synchronous (returns the id immediately,
 * fires the POST in the background). The id is client-generated so the
 * caller can write to other in-memory state without waiting for the round
 * trip; if the POST fails the cache is rolled back and an `onError`
 * callback fires (if supplied).
 *
 * Legacy localStorage data lives at `STORAGE_KEY` for use by the migration
 * tool only — HistoryStore itself never writes to localStorage anymore.
 */

import {
  appendFinalToApi,
  bulkClearAudio,
  createSession,
  deleteSession as deleteSessionApi,
  listSessions,
  patchSession,
  uploadAudio,
  type CaptureMode,
  type SessionFull,
} from "./history-api-client";

export const STORAGE_KEY = "whisper-wrap.sessions";
export const DEFAULT_RETENTION = 20;

/** Recordings shorter than this are treated as accidental taps and discarded. */
export const MIN_USABLE_DURATION_MS = 500;

export function sessionDurationMs(s: SessionRecord): number {
  // Finals' max end_ms is the authoritative recording duration. In BATCH
  // mode the session lifecycle covers only the upload+STT roundtrip (~30ms,
  // because `startSession` runs AFTER `batch.stop()` returns), NOT the audio
  // length — so `ended_at - started_at` is misleadingly tiny and would render
  // as "0.0s". In LIVE mode both signals agree (finals are timestamped
  // relative to recordingStartedAt which equals started_at). Prefer finals
  // unconditionally so batch + live both read correctly.
  if (s.finals.length > 0) {
    let maxEnd = 0;
    for (const f of s.finals) if (f.end_ms > maxEnd) maxEnd = f.end_ms;
    return maxEnd;
  }
  // No finals: lifecycle gap is the only signal we have. Useful for live
  // sessions that ended without any final (server-side STT silence).
  if (s.ended_at !== null) return Math.max(0, s.ended_at - s.started_at);
  return 0;
}

/** ISO-style local datetime — single source of truth for both the slim
 *  sidebar and the master-detail HistoryView so a session never reads
 *  differently in two places (`2026-05-18 14:04:58`). */
export function formatSessionDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Latest AI response text for a session, or null if no runs.
 *  Action_runs come back in arbitrary order; we sort by ran_at DESC and
 *  return the freshest answer. iOS Safari requires synchronous extraction
 *  inside the click handler so consumers SHALL call this AHEAD of the
 *  `await navigator.clipboard.writeText` boundary. */
export function latestActionAnswer(s: SessionRecord): string | null {
  if (s.action_runs.length === 0) return null;
  let best = s.action_runs[0];
  for (const r of s.action_runs) if (r.ran_at > best.ran_at) best = r;
  return best.answer;
}

/** Short one-line preview of a session's finals for the list rows. */
export function sessionPreview(s: SessionRecord, maxChars = 60): string {
  if (s.finals.length === 0) return "";
  const joined = s.finals.map((f) => f.text).join(" ").replace(/\s+/g, " ").trim();
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars - 1) + "…";
}

export function formatSessionDuration(ms: number): string {
  const tenths = Math.floor(ms / 100);
  const totalSec = Math.floor(tenths / 10);
  const decimal = tenths % 10;
  if (totalSec < 60) {
    return `${totalSec}.${decimal}s`;
  }
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, "0")}.${decimal}`;
}

export interface SessionFinal {
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface ActionRun {
  /** Backend autoincrement id, populated after a successful POST /runs round-trip
   *  OR when the record came from the API on `prime()`. Absent only on transient
   *  client-built records that have not yet been persisted. */
  id?: number;
  action_id: string;
  prompt: string;
  answer: string;
  ran_at: number;
}

export interface SessionRecord {
  id: string;
  started_at: number;
  ended_at: number | null;
  finals: SessionFinal[];
  action_runs: ActionRun[];
  /** Derived from `audio_path !== null` once the API populates it. */
  audio_saved?: boolean;
}

export interface HistoryStoreOptions {
  backendUrl: () => string;
  /** Called when a background API write fails. Receives the error + which
   *  session it was for. Use to surface a toast / log so silent failures
   *  don't leave the cache out of sync. */
  onError?: (err: unknown, ctx: { op: string; sessionId?: string }) => void;
}

export class HistoryStore {
  private retention = DEFAULT_RETENTION;
  /** Newest-first cache of sessions. Mutated only via _setCache wrappers
   *  so we keep a single ordering invariant. */
  private cache: SessionRecord[] = [];
  /** In-flight `POST /v1/sessions` promises, keyed by session id. Every
   *  session-scoped write (appendFinal, appendActionRun, stopSession,
   *  uploadSessionAudio, …) awaits this before its own request so a fast
   *  WS final doesn't race ahead and hit a 404 ("session not found"). */
  private pendingCreate = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: HistoryStoreOptions = { backendUrl: () => "" }) {}

  /** Resolve once the create POST for this id has settled (success or
   *  failure). No-op if create already completed. Failures are swallowed
   *  here — the create's own catch already surfaced them via onError. */
  private async awaitCreate(id: string): Promise<void> {
    const p = this.pendingCreate.get(id);
    if (!p) return;
    try {
      await p;
    } catch {
      // ignored; create's own .catch handler already surfaced via onError
    }
  }

  /** Initial fetch — call once at startup before the history panel renders. */
  async prime(): Promise<void> {
    try {
      const r = await listSessions(this.opts.backendUrl(), {
        limit: this.retention,
      });
      this.cache = r.sessions.map(sessionFromDigest);
    } catch (e) {
      this.opts.onError?.(e, { op: "prime" });
      this.cache = [];
    }
  }

  list(): SessionRecord[] {
    // Newest-first (started_at DESC) — backend already returns this order.
    return [...this.cache];
  }

  startSession(mode: CaptureMode = "batch"): string {
    const id = generateId();
    const started_at = Date.now();
    const record: SessionRecord = {
      id,
      started_at,
      ended_at: null,
      finals: [],
      action_runs: [],
    };
    this.cache = [record, ...this.cache];
    // Track the POST so session-scoped writes (appendFinal, etc.) can wait
    // for it to land before issuing their own requests against /{id}.
    const p = createSession(this.opts.backendUrl(), { id, started_at, mode })
      .catch((e) => this.opts.onError?.(e, { op: "startSession", sessionId: id }));
    this.pendingCreate.set(
      id,
      p.finally(() => this.pendingCreate.delete(id)),
    );
    return id;
  }

  async appendFinal(id: string, final: SessionFinal): Promise<void> {
    const session = this.cache.find((s) => s.id === id);
    if (!session) {
      throw new Error(`HistoryStore: unknown session id ${id}`);
    }
    await this.awaitCreate(id);
    try {
      await appendFinalToApi(this.opts.backendUrl(), id, final);
      session.finals.push(final);
    } catch (e) {
      this.opts.onError?.(e, { op: "appendFinal", sessionId: id });
      throw e;
    }
  }

  async stopSession(id: string): Promise<void> {
    const session = this.cache.find((s) => s.id === id);
    if (!session) {
      throw new Error(`HistoryStore: unknown session id ${id}`);
    }
    await this.awaitCreate(id);
    const ended_at = Date.now();
    try {
      await patchSession(this.opts.backendUrl(), id, {
        ended_at,
        duration_ms: ended_at - session.started_at,
      });
      session.ended_at = ended_at;
    } catch (e) {
      this.opts.onError?.(e, { op: "stopSession", sessionId: id });
      throw e;
    }
  }

  async deleteSession(id: string): Promise<void> {
    const previous = this.cache;
    this.cache = this.cache.filter((s) => s.id !== id);
    try {
      await deleteSessionApi(this.opts.backendUrl(), id);
    } catch (e) {
      // Roll back the cache so the UI re-renders consistently.
      this.cache = previous;
      this.opts.onError?.(e, { op: "deleteSession", sessionId: id });
      throw e;
    }
  }

  setRetention(n: number): void {
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`Retention must be a positive integer, got ${n}`);
    }
    this.retention = Math.floor(n);
    // Trim cache to new cap (backend doesn't enforce retention).
    if (this.cache.length > this.retention) {
      this.cache = this.cache.slice(0, this.retention);
    }
  }

  async clear(): Promise<void> {
    // Convenience for tests / settings: wipe local cache only. Server-side
    // bulk delete would require a per-session DELETE storm; the audio bulk
    // clear is a separate operation.
    this.cache = [];
  }

  /** Upload audio for a session and stamp the metadata back into the cache. */
  async uploadSessionAudio(
    id: string,
    blob: Blob,
    mimeType: string,
  ): Promise<void> {
    await this.awaitCreate(id);
    try {
      const meta = await uploadAudio(this.opts.backendUrl(), id, blob, mimeType);
      const session = this.cache.find((s) => s.id === id);
      if (session) {
        session.audio_saved = !!meta.audio_path;
      }
    } catch (e) {
      this.opts.onError?.(e, { op: "uploadSessionAudio", sessionId: id });
      throw e;
    }
  }

  /** Bulk clear all audio files via backend; mark cache rows as unsaved. */
  async bulkClearAudio(): Promise<number> {
    const r = await bulkClearAudio(this.opts.backendUrl());
    for (const s of this.cache) {
      s.audio_saved = false;
    }
    return r.deleted_count;
  }

  /** Test hook only — replace cache contents with a known seed. */
  __setCacheForTests(records: SessionRecord[]): void {
    this.cache = [...records];
  }
}

function sessionFromDigest(d: SessionFull | {
  id: string;
  started_at: number;
  ended_at: number | null;
  audio_path: string | null;
}): SessionRecord {
  const full = "finals" in d ? d : undefined;
  return {
    id: d.id,
    started_at: d.started_at,
    ended_at: d.ended_at,
    finals: full
      ? full.finals.map((f) => ({
          text: f.text,
          start_ms: f.start_ms ?? 0,
          end_ms: f.end_ms ?? 0,
        }))
      : [],
    action_runs: full
      ? full.action_runs.map((r) => ({
          id: r.id,
          action_id: r.action_id,
          prompt: r.prompt,
          answer: r.answer,
          ran_at: r.ran_at,
        }))
      : [],
    audio_saved: d.audio_path !== null,
  };
}

export function generateId(): string {
  // ULID-style: timestamp + random suffix. Not cryptographic; adequate for
  // client-side session identity that's also used as the backend PK.
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(5, "0");
  return `${t}-${r}`;
}
