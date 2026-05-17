/**
 * IndexedDB store for per-session compressed audio blobs.
 *
 * Schema (version 1):
 *   db     : whisper-wrap
 *   store  : audio, keyPath session_id
 *   index  : by_stored_at on stored_at (asc) — drives FIFO eviction
 *
 * Eviction: when `put()` would push total bytes over the budget, the oldest
 * records by `stored_at` are deleted (cheapest read — index + byte_size only;
 * the blob bytes themselves are never loaded) until the new record fits.
 *
 * The matching localStorage entry in `whisper-wrap.sessions` is never touched
 * by eviction — that decouples audio retention from transcript retention.
 */

export const AUDIO_DB_NAME = "whisper-wrap";
export const AUDIO_DB_VERSION = 1;
export const AUDIO_STORE_NAME = "audio";
const STORED_AT_INDEX = "by_stored_at";

export const AUDIO_BUDGET_KEY = "whisper-wrap.audio_budget";
export const DEFAULT_AUDIO_BUDGET_BYTES = 100 * 1024 * 1024;

export interface StoredAudio {
  session_id: string;
  mime_type: string;
  blob: Blob;
  duration_ms: number;
  byte_size: number;
  stored_at: number;
}

export interface AudioStoreOptions {
  /** Override for `Date.now`; primarily for deterministic tests. */
  now?: () => number;
}

export class AudioStore {
  private budget: number;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly now: () => number;
  private lastEvicted = 0;

  constructor(opts: AudioStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.budget = readBudgetFromStorage();
  }

  budgetBytes(): number {
    return this.budget;
  }

  /**
   * Set the runtime budget in bytes and persist it. Caller is responsible
   * for converting from megabytes if needed.
   */
  setBudgetBytes(n: number): void {
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`AudioStore: invalid budget ${n}`);
    }
    this.budget = Math.floor(n);
    window.localStorage.setItem(AUDIO_BUDGET_KEY, String(this.budget));
  }

  /** How many records were evicted during the most recent `put()`. */
  lastEvictionCount(): number {
    return this.lastEvicted;
  }

  /**
   * Close the underlying IndexedDB connection. Primarily for tests so a
   * subsequent `deleteDatabase()` does not block on open handles. Safe to
   * call multiple times; the store will reopen lazily on the next request.
   */
  async close(): Promise<void> {
    const p = this.dbPromise;
    this.dbPromise = null;
    if (!p) return;
    try {
      const db = await p;
      db.close();
    } catch {
      // open had already failed; nothing to close.
    }
  }

  async put(
    session_id: string,
    blob: Blob,
    duration_ms: number,
  ): Promise<void> {
    const newSize = blob.size;
    const record: StoredAudio = {
      session_id,
      mime_type: blob.type || "audio/webm",
      blob,
      duration_ms,
      byte_size: newSize,
      stored_at: this.now(),
    };

    const db = await this.openDb();
    // 1) Eviction pass — read existing index entries, drop oldest until we fit.
    this.lastEvicted = await this.evictForIncoming(db, session_id, newSize);
    // 2) Insert the new record in a fresh transaction. Failure here surfaces
    //    to the caller; previous deletes have already committed.
    await runTx(db, "readwrite", (store) => store.put(record));
  }

  async get(session_id: string): Promise<StoredAudio | null> {
    const db = await this.openDb();
    return new Promise<StoredAudio | null>((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE_NAME, "readonly");
      const req = tx.objectStore(AUDIO_STORE_NAME).get(session_id);
      req.onsuccess = () =>
        resolve((req.result as StoredAudio | undefined) ?? null);
      req.onerror = () => reject(unavailable(req.error));
    });
  }

  async delete(session_id: string): Promise<void> {
    const db = await this.openDb();
    await runTx(db, "readwrite", (store) => store.delete(session_id));
  }

  async clear(): Promise<number> {
    const db = await this.openDb();
    const count = await this.count(db);
    await runTx(db, "readwrite", (store) => store.clear());
    return count;
  }

  async totalBytes(): Promise<number> {
    const db = await this.openDb();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE_NAME, "readonly");
      const store = tx.objectStore(AUDIO_STORE_NAME);
      let total = 0;
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const value = cursor.value as StoredAudio;
          total += value.byte_size ?? 0;
          cursor.continue();
        } else {
          resolve(total);
        }
      };
      req.onerror = () => reject(unavailable(req.error));
    });
  }

  /** Walk the by_stored_at index ascending, delete records until newSize fits. */
  private async evictForIncoming(
    db: IDBDatabase,
    incomingId: string,
    newSize: number,
  ): Promise<number> {
    if (newSize > this.budget) {
      // The single new record is itself larger than the entire budget.
      // Best we can do is evict everything else and still accept it — the
      // user explicitly chose this budget, but we honour persistence over
      // eviction-to-failure.
    }

    const existing = await this.snapshotIndex(db, incomingId);
    let total = existing.reduce((acc, r) => acc + r.byte_size, 0);
    const toDelete: string[] = [];
    for (const rec of existing) {
      if (total + newSize <= this.budget) break;
      toDelete.push(rec.session_id);
      total -= rec.byte_size;
    }
    if (toDelete.length > 0) {
      await runTx(db, "readwrite", (store) => {
        for (const id of toDelete) store.delete(id);
      });
    }
    return toDelete.length;
  }

  /**
   * Index-only snapshot: (session_id, byte_size) tuples in stored_at ascending
   * order, EXCLUDING the incoming id (we're about to overwrite that record so
   * its old size is moot).
   */
  private snapshotIndex(
    db: IDBDatabase,
    excludeId: string,
  ): Promise<Array<{ session_id: string; byte_size: number; stored_at: number }>> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE_NAME, "readonly");
      const idx = tx.objectStore(AUDIO_STORE_NAME).index(STORED_AT_INDEX);
      const out: Array<{
        session_id: string;
        byte_size: number;
        stored_at: number;
      }> = [];
      const req = idx.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const value = cursor.value as StoredAudio;
          if (value.session_id !== excludeId) {
            out.push({
              session_id: value.session_id,
              byte_size: value.byte_size ?? 0,
              stored_at: value.stored_at ?? 0,
            });
          }
          cursor.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => reject(unavailable(req.error));
    });
  }

  private count(db: IDBDatabase): Promise<number> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE_NAME, "readonly");
      const req = tx.objectStore(AUDIO_STORE_NAME).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(unavailable(req.error));
    });
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(AUDIO_DB_NAME, AUDIO_DB_VERSION);
      } catch (e) {
        reject(unavailable(e));
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(AUDIO_STORE_NAME)) {
          const store = db.createObjectStore(AUDIO_STORE_NAME, {
            keyPath: "session_id",
          });
          store.createIndex(STORED_AT_INDEX, "stored_at", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(unavailable(req.error));
      req.onblocked = () =>
        reject(unavailable(new Error("upgrade blocked by another tab")));
    });
    return this.dbPromise;
  }
}

function runTx(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE_NAME, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(unavailable(tx.error));
    tx.onabort = () => reject(unavailable(tx.error));
    body(tx.objectStore(AUDIO_STORE_NAME));
  });
}

function unavailable(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err ?? "unknown");
  return new Error(`audio-store unavailable: ${message}`);
}

function readBudgetFromStorage(): number {
  try {
    const raw = window.localStorage.getItem(AUDIO_BUDGET_KEY);
    if (!raw) return DEFAULT_AUDIO_BUDGET_BYTES;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_AUDIO_BUDGET_BYTES;
    return n;
  } catch {
    return DEFAULT_AUDIO_BUDGET_BYTES;
  }
}
