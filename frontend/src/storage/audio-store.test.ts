/**
 * Tests for AudioStore — IndexedDB per-session audio persistence with
 * FIFO eviction by `stored_at`.
 *
 * happy-dom has no IndexedDB; pull in `fake-indexeddb/auto` to install
 * `indexedDB` + `IDBKeyRange` on globalThis for the test environment.
 */

import "fake-indexeddb/auto";
// `fake-indexeddb/lib/FDBFactory`'s typings aren't exposed via the package's
// `exports` map, so we go through the umbrella entry which does.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — fake-indexeddb does not publish a typed FDBFactory entry.
import FDBFactory from "fake-indexeddb/lib/FDBFactory";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { AudioStore, AUDIO_DB_NAME, AUDIO_STORE_NAME } from "./audio-store";
import { STORAGE_KEY as SESSIONS_KEY } from "./history-store";

function makeBlob(sizeBytes: number, mime = "audio/webm;codecs=opus"): Blob {
  // Fill with zero bytes — actual contents don't matter for store tests.
  return new Blob([new Uint8Array(sizeBytes)], { type: mime });
}

/**
 * Reset the fake IndexedDB factory entirely. This is the cleanest cross-test
 * isolation: we don't have to track open connections — every test gets a
 * fresh `indexedDB` global. Using `deleteDatabase()` would block forever if
 * any prior store hadn't closed its connection.
 */
function resetIdb(): void {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new FDBFactory();
}

describe("AudioStore", () => {
  const liveStores: AudioStore[] = [];

  beforeEach(() => {
    window.localStorage.clear();
    resetIdb();
    liveStores.length = 0;
  });

  afterEach(async () => {
    for (const s of liveStores) await s.close();
  });

  // Wrapper so the afterEach hook always sees the stores under test.
  function makeStore(opts?: ConstructorParameters<typeof AudioStore>[0]): AudioStore {
    const s = new AudioStore(opts);
    liveStores.push(s);
    return s;
  }

  it("put / get / delete round-trips a record against the IndexedDB schema", async () => {
    const store = makeStore();
    const blob = makeBlob(1024);
    await store.put("session-A", blob, 5000);

    const got = await store.get("session-A");
    expect(got).not.toBeNull();
    expect(got!.session_id).toBe("session-A");
    expect(got!.mime_type).toBe("audio/webm;codecs=opus");
    expect(got!.byte_size).toBe(1024);
    expect(got!.duration_ms).toBe(5000);
    expect(typeof got!.stored_at).toBe("number");
    // fake-indexeddb's structured clone preserves the Blob's MIME but does
    // not expose `.size` reliably; we keep `byte_size` denormalised on the
    // record (asserted above) so callers never need to read the blob to know
    // its size. Real browsers return a real Blob with `.size` intact.
    expect(got!.blob.type).toBe("audio/webm;codecs=opus");

    await store.delete("session-A");
    expect(await store.get("session-A")).toBeNull();
  });

  it("get returns null for missing session_id", async () => {
    const store = makeStore();
    expect(await store.get("never-existed")).toBeNull();
  });

  it("totalBytes sums byte_size across all records", async () => {
    const store = makeStore();
    await store.put("a", makeBlob(100), 1000);
    await store.put("b", makeBlob(200), 1000);
    await store.put("c", makeBlob(50), 1000);
    expect(await store.totalBytes()).toBe(350);
  });

  it("clear deletes every record and returns the count", async () => {
    const store = makeStore();
    await store.put("a", makeBlob(10), 100);
    await store.put("b", makeBlob(20), 100);
    await store.put("c", makeBlob(30), 100);
    const count = await store.clear();
    expect(count).toBe(3);
    expect(await store.totalBytes()).toBe(0);
    expect(await store.get("a")).toBeNull();
  });

  it("the schema declares the by_stored_at index", async () => {
    const store = makeStore();
    await store.put("a", makeBlob(10), 100);
    // Open the database directly and inspect the index — proves the schema
    // was migrated, not just that put/get round-trip.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(AUDIO_DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction(AUDIO_STORE_NAME, "readonly");
    const objStore = tx.objectStore(AUDIO_STORE_NAME);
    expect(objStore.indexNames.contains("by_stored_at")).toBe(true);
    db.close();
  });

  describe("FIFO eviction by stored_at until under budget", () => {
    it("inserts without eviction when total fits the budget", async () => {
      const store = makeStore();
      store.setBudgetBytes(1000);
      await store.put("a", makeBlob(100), 0);
      await store.put("b", makeBlob(100), 0);
      expect(await store.totalBytes()).toBe(200);
      const evicted = store.lastEvictionCount();
      expect(evicted).toBe(0);
    });

    it("evicts oldest records by stored_at until the new blob fits", async () => {
      // Spec example: budget 10 MB, A=5MB t=1, B=3MB t=2, C=1MB t=3,
      // inserting D=7MB t=4 → A and B evicted, store becomes {C, D} = 8 MB.
      const store = makeStore({ now: makeIncrementingClock(1) });
      store.setBudgetBytes(10 * 1024 * 1024); // 10 MB
      await store.put("A", makeBlob(5 * 1024 * 1024), 0);
      await store.put("B", makeBlob(3 * 1024 * 1024), 0);
      await store.put("C", makeBlob(1 * 1024 * 1024), 0);
      expect(await store.totalBytes()).toBe(9 * 1024 * 1024);

      await store.put("D", makeBlob(7 * 1024 * 1024), 0);
      expect(store.lastEvictionCount()).toBe(2);

      expect(await store.get("A")).toBeNull();
      expect(await store.get("B")).toBeNull();
      expect(await store.get("C")).not.toBeNull();
      expect(await store.get("D")).not.toBeNull();
      expect(await store.totalBytes()).toBe(8 * 1024 * 1024);
    });

    it("eviction never touches the localStorage history-store entry", async () => {
      const store = makeStore({ now: makeIncrementingClock(1) });
      store.setBudgetBytes(100);

      // Pre-populate sessions in localStorage matching the audio records.
      const sessions = {
        version: 1,
        retention: 20,
        sessions: [
          {
            id: "A",
            started_at: 1,
            ended_at: 10,
            finals: [{ text: "alpha", start_ms: 0, end_ms: 1 }],
            action_runs: [],
          },
          {
            id: "B",
            started_at: 2,
            ended_at: 20,
            finals: [{ text: "beta", start_ms: 0, end_ms: 1 }],
            action_runs: [],
          },
        ],
      };
      window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));

      await store.put("A", makeBlob(60), 0);
      await store.put("B", makeBlob(50), 0); // Evicts A.
      expect(store.lastEvictionCount()).toBe(1);

      const after = JSON.parse(window.localStorage.getItem(SESSIONS_KEY)!) as {
        sessions: { id: string }[];
      };
      const ids = after.sessions.map((s) => s.id).sort();
      expect(ids).toEqual(["A", "B"]); // Both still present.
    });

    it("evicts in stored_at ascending order even when insert order differs", async () => {
      const store = makeStore({ now: makeFixedClock([300, 100, 200, 400]) });
      store.setBudgetBytes(50);
      await store.put("first-inserted-newest", makeBlob(20), 0); // stored_at=300
      await store.put("second-oldest", makeBlob(20), 0); // stored_at=100
      await store.put("third-middle", makeBlob(20), 0); // stored_at=200
      // Total 60 > 50 — eviction must drop the OLDEST by stored_at (=100).
      // Inserting next 20-byte blob: total 80 → 60 → evict next oldest (200) → 40.
      await store.put("D", makeBlob(20), 0);
      expect(store.lastEvictionCount()).toBeGreaterThanOrEqual(1);
      expect(await store.get("second-oldest")).toBeNull();
    });

    it("setBudgetBytes persists the budget to localStorage", () => {
      const store = makeStore();
      store.setBudgetBytes(25 * 1024 * 1024);
      const raw = window.localStorage.getItem("whisper-wrap.audio_budget");
      expect(raw).toBe(String(25 * 1024 * 1024));

      // A fresh store instance reads the persisted budget back.
      const other = makeStore();
      // Trigger an eviction at the new budget so we can assert it was loaded.
      // Easiest: ensure totalBytes does not exceed the new budget after a put.
      expect(other.budgetBytes()).toBe(25 * 1024 * 1024);
    });
  });
});

/**
 * Returns a `now()` function that yields a monotonically increasing
 * value starting at `start`, incremented by 1 on each call.
 *
 * Used to make `stored_at` ordering deterministic in tests.
 */
function makeIncrementingClock(start: number): () => number {
  let n = start;
  return () => n++;
}

/**
 * Returns a `now()` function that yields the next value from the given
 * sequence on each call. Throws if called more times than the sequence has
 * values — surfaces test bugs immediately.
 */
function makeFixedClock(seq: number[]): () => number {
  let i = 0;
  return () => {
    if (i >= seq.length) throw new Error(`clock exhausted at call ${i}`);
    return seq[i++];
  };
}
