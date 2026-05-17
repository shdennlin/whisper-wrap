/**
 * Tests for the one-shot localStorage → backend migration tool.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEY } from "../storage/history-store";
import {
  hasLegacyData,
  importLegacyData,
  type ImportLegacyDeps,
} from "./import-legacy";

const SAMPLE_LEGACY = {
  version: 1,
  sessions: [
    {
      id: "s-1",
      started_at: 1000,
      ended_at: 2000,
      finals: [
        { text: "hi", start_ms: 0, end_ms: 100 },
        { text: "there", start_ms: 100, end_ms: 200 },
      ],
      action_runs: [
        {
          action_id: "polish",
          prompt: "polish:\nhi there",
          answer: "Hi, there.",
          ran_at: 1500,
        },
      ],
    },
    {
      id: "s-2",
      started_at: 3000,
      ended_at: 4000,
      finals: [{ text: "world", start_ms: 0, end_ms: 50 }],
      action_runs: [],
    },
  ],
};

describe("hasLegacyData", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns false when localStorage is empty", () => {
    expect(hasLegacyData()).toBe(false);
  });

  it("returns false when key contains invalid JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not valid json");
    expect(hasLegacyData()).toBe(false);
  });

  it("returns false when sessions array is empty", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, sessions: [] }),
    );
    expect(hasLegacyData()).toBe(false);
  });

  it("returns true when there is at least one session", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(SAMPLE_LEGACY));
    expect(hasLegacyData()).toBe(true);
  });
});

describe("importLegacyData", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let deps: ImportLegacyDeps;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    window.localStorage.clear();
    deps = { backendUrl: () => "http://test" };
  });

  function mockJson(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("returns zero counts when localStorage is empty", async () => {
    const r = await importLegacyData(deps);
    expect(r.sessionsImported).toBe(0);
    expect(r.finalsImported).toBe(0);
    expect(r.runsImported).toBe(0);
    expect(r.errors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("imports every session + finals + runs, then clears localStorage", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(SAMPLE_LEGACY));
    // 2 sessions × (1 create + 2 finals + 1 run) for s-1 and (1 create + 1 final) for s-2
    // = 4 + 2 = 6 calls
    for (let i = 0; i < 6; i++) {
      fetchMock.mockResolvedValueOnce(mockJson({ ok: true }, 201));
    }
    const r = await importLegacyData(deps);
    expect(r.sessionsImported).toBe(2);
    expect(r.finalsImported).toBe(3);
    expect(r.runsImported).toBe(1);
    expect(r.errors).toEqual([]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("preserves localStorage on partial failure", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(SAMPLE_LEGACY));
    // s-1: create ok, final ok, final ok, run ok (4 calls)
    fetchMock.mockResolvedValueOnce(mockJson({}, 201));
    fetchMock.mockResolvedValueOnce(mockJson({}, 201));
    fetchMock.mockResolvedValueOnce(mockJson({}, 201));
    fetchMock.mockResolvedValueOnce(mockJson({}, 201));
    // s-2: create fails with 500
    fetchMock.mockResolvedValueOnce(mockJson({ detail: "boom" }, 500));

    const r = await importLegacyData(deps);
    expect(r.sessionsImported).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].sessionId).toBe("s-2");
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("treats 409 on session create as 'already imported' (skip, no error)", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        sessions: [SAMPLE_LEGACY.sessions[0]],
      }),
    );
    fetchMock.mockResolvedValueOnce(mockJson({ detail: "already exists" }, 409));
    const r = await importLegacyData(deps);
    expect(r.sessionsImported).toBe(1); // counted as imported
    expect(r.errors).toEqual([]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("uses readLocalStorage / clearLocalStorage overrides when supplied", async () => {
    const calls: string[] = [];
    const readSpy = vi.fn(() => JSON.stringify(SAMPLE_LEGACY));
    const clearSpy = vi.fn(() => calls.push("cleared"));
    for (let i = 0; i < 6; i++) {
      fetchMock.mockResolvedValueOnce(mockJson({}, 201));
    }
    await importLegacyData({
      backendUrl: () => "http://t",
      readLocalStorage: readSpy,
      clearLocalStorage: clearSpy,
    });
    expect(readSpy).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["cleared"]);
  });
});
