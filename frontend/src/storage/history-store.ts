/**
 * Per-session capture history persisted to `localStorage`.
 *
 * Decision 4: writes happen incrementally on every `final` event (not only on
 * stop), capped at 20 sessions, oldest-by-`started_at` evicted on overflow.
 *
 * Schema (versioned under `STORAGE_KEY`):
 *   {
 *     "version": 1,
 *     "sessions": [SessionRecord, ...]  // any order; sorted at read time
 *   }
 */

export const STORAGE_KEY = "whisper-wrap.sessions";
export const DEFAULT_RETENTION = 20;
const SCHEMA_VERSION = 1;

/**
 * Recordings shorter than this are treated as accidental taps and discarded
 * without going into history. 500 ms = 2 AudioWorklet frames, enough that the
 * user actually intended to record but small enough to never lose a real
 * utterance.
 */
export const MIN_USABLE_DURATION_MS = 500;

/** Returns the recording duration in ms, or 0 if the session is still open. */
export function sessionDurationMs(s: SessionRecord): number {
  if (s.ended_at === null) return 0;
  return Math.max(0, s.ended_at - s.started_at);
}

/**
 * Format a duration with one decimal place under 60 s, mm:ss for longer takes.
 * Used in the history list so users can eyeball which sessions were
 * accidental clicks vs real recordings.
 */
export function formatSessionDuration(ms: number): string {
  if (ms < 60_000) {
    const tenths = Math.floor(ms / 100);
    const sec = Math.floor(tenths / 10);
    const decimal = tenths % 10;
    return `${sec}.${decimal}s`;
  }
  const totalSec = Math.floor(ms / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

export interface SessionFinal {
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface ActionRun {
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
}

interface PersistedState {
  version: number;
  sessions: SessionRecord[];
  retention: number;
}

export class HistoryStore {
  private retention = DEFAULT_RETENTION;

  list(): SessionRecord[] {
    const state = this.load();
    // Insertion order is chronological; reverse for "newest first" without
    // relying on Date.now() being unique (tight loops can produce ties).
    return [...state.sessions].reverse();
  }

  startSession(): string {
    const state = this.load();
    const id = generateId();
    state.sessions.push({
      id,
      started_at: Date.now(),
      ended_at: null,
      finals: [],
      action_runs: [],
    });
    this.persist(this.enforceRetention(state));
    return id;
  }

  appendFinal(id: string, final: SessionFinal): void {
    this.mutate(id, (s) => {
      s.finals.push(final);
    });
  }

  appendActionRun(id: string, run: ActionRun): void {
    this.mutate(id, (s) => {
      s.action_runs.push(run);
    });
  }

  stopSession(id: string): void {
    this.mutate(id, (s) => {
      s.ended_at = Date.now();
    });
  }

  deleteSession(id: string): void {
    const state = this.load();
    state.sessions = state.sessions.filter((s) => s.id !== id);
    this.persist(state);
  }

  setRetention(n: number): void {
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`Retention must be a positive integer, got ${n}`);
    }
    // Load first (which may overwrite this.retention from persisted state),
    // then set the new retention so it sticks for both this call and the
    // persisted snapshot.
    const state = this.load();
    this.retention = Math.floor(n);
    state.retention = this.retention;
    this.persist(this.enforceRetention(state));
  }

  clear(): void {
    window.localStorage.removeItem(STORAGE_KEY);
  }

  private mutate(id: string, fn: (s: SessionRecord) => void): void {
    const state = this.load();
    const session = state.sessions.find((s) => s.id === id);
    if (!session) {
      throw new Error(`HistoryStore: unknown session id ${id}`);
    }
    fn(session);
    this.persist(state);
  }

  private enforceRetention(state: PersistedState): PersistedState {
    if (state.sessions.length <= this.retention) return state;
    // Insertion order is chronological, so the oldest are at the front. Drop
    // the surplus from the head. (Avoids relying on Date.now() being unique.)
    state.sessions.splice(0, state.sessions.length - this.retention);
    return state;
  }

  private load(): PersistedState {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { version: SCHEMA_VERSION, sessions: [], retention: this.retention };
    }
    try {
      const parsed = JSON.parse(raw) as PersistedState;
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(parsed.sessions)
      ) {
        if (typeof parsed.retention === "number") this.retention = parsed.retention;
        return {
          version: parsed.version ?? SCHEMA_VERSION,
          sessions: parsed.sessions,
          retention: this.retention,
        };
      }
    } catch {
      // Fall through to a clean state.
    }
    return { version: SCHEMA_VERSION, sessions: [], retention: this.retention };
  }

  private persist(state: PersistedState): void {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

function generateId(): string {
  // Lightweight ULID-style ID (timestamp + random suffix). Not cryptographic;
  // adequate for client-side session identity.
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(5, "0");
  return `${t}-${r}`;
}
