/**
 * Tests for HistoryStore (now backed by /v1/sessions REST instead of
 * localStorage). formatSessionDuration kept here because it's the only
 * pure helper still in this module.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  HistoryStore,
  formatSessionDuration,
  sessionDurationMs,
  type SessionRecord,
} from "./history-store";

describe("formatSessionDuration", () => {
  it("shows tenths-of-second under one minute", () => {
    expect(formatSessionDuration(0)).toBe("0.0s");
    expect(formatSessionDuration(300)).toBe("0.3s");
    expect(formatSessionDuration(12_345)).toBe("12.3s");
    expect(formatSessionDuration(59_900)).toBe("59.9s");
  });

  it("shows mm:ss.x at or over one minute", () => {
    expect(formatSessionDuration(60_000)).toBe("1:00.0");
    expect(formatSessionDuration(60_500)).toBe("1:00.5");
    expect(formatSessionDuration(125_400)).toBe("2:05.4");
    expect(formatSessionDuration(600_000)).toBe("10:00.0");
  });
});

describe("sessionDurationMs", () => {
  const base = {
    id: "s",
    started_at: 1_000,
    action_runs: [] as SessionRecord["action_runs"],
  };

  it("uses ended_at - started_at when ended_at is set", () => {
    expect(
      sessionDurationMs({ ...base, ended_at: 5_500, finals: [] }),
    ).toBe(4_500);
  });

  it("clamps negative durations to 0", () => {
    expect(
      sessionDurationMs({ ...base, ended_at: 500, finals: [] }),
    ).toBe(0);
  });

  it("returns 0 when ended_at null AND no finals (live or abandoned)", () => {
    expect(
      sessionDurationMs({ ...base, ended_at: null, finals: [] }),
    ).toBe(0);
  });

  it("falls back to max finals.end_ms when ended_at is null but finals exist", () => {
    expect(
      sessionDurationMs({
        ...base,
        ended_at: null,
        finals: [
          { text: "hi", start_ms: 100, end_ms: 800 },
          { text: "there", start_ms: 900, end_ms: 2_400 },
          { text: "stale", start_ms: 50, end_ms: 200 },
        ],
      }),
    ).toBe(2_400);
  });
});

describe("HistoryStore (API-backed)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  function mockJson(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function makeStore(): HistoryStore {
    return new HistoryStore({ backendUrl: () => "http://test" });
  }

  it("prime() populates the cache with one GET /v1/sessions", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson({
        sessions: [
          {
            id: "s1",
            started_at: 100,
            ended_at: 200,
            mode: "batch",
            audio_path: null,
            audio_mime_type: null,
            audio_size_bytes: null,
            duration_ms: 100,
          },
        ],
        next_before_ms: null,
      }),
    );

    const store = makeStore();
    await store.prime();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toMatch(/\/v1\/sessions\?limit=/);

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("s1");
  });

  it("startSession returns id synchronously and fires POST in background", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson(
        {
          id: "ignored",
          started_at: 0,
          ended_at: null,
          mode: "batch",
          audio_path: null,
          audio_mime_type: null,
          audio_size_bytes: null,
          duration_ms: null,
          finals: [],
          action_runs: [],
        },
        201,
      ),
    );

    const store = makeStore();
    const id = store.startSession("batch");
    expect(typeof id).toBe("string");
    expect(store.list().some((s) => s.id === id)).toBe(true);
    // Let the background POST resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe("http://test/v1/sessions");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("appendFinal waits for the in-flight startSession POST before its own request", async () => {
    // Defer the create response so we can interleave appendFinal in the
    // pre-resolved gap — this reproduces the 404 race that production hit
    // ("history appendFinal failed: HTTP 404 — session not found").
    let resolveCreate!: (r: Response) => void;
    const createPromise = new Promise<Response>((r) => {
      resolveCreate = r;
    });
    const createBody = mockJson(
      {
        id: "ignored",
        started_at: 0,
        ended_at: null,
        mode: "live",
        audio_path: null,
        audio_mime_type: null,
        audio_size_bytes: null,
        duration_ms: null,
        finals: [],
        action_runs: [],
      },
      201,
    );
    fetchMock.mockReturnValueOnce(createPromise);
    fetchMock.mockResolvedValueOnce(mockJson({ session_id: "x", ord: 0 }, 201));

    const store = makeStore();
    const id = store.startSession("live");
    // appendFinal is called immediately, before the create POST resolves.
    const finalPromise = store.appendFinal(id, {
      text: "hello",
      start_ms: 0,
      end_ms: 200,
    });

    // Yield once: appendFinal SHALL still be pending because awaitCreate is
    // blocking it on the create POST.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://test/v1/sessions");

    // Release create — now appendFinal SHALL fire its POST.
    resolveCreate(createBody);
    await finalPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      `http://test/v1/sessions/${id}/finals`,
    );
    expect(store.list().find((s) => s.id === id)!.finals).toHaveLength(1);
  });

  it("appendFinal updates the cache only after a 2xx response", async () => {
    fetchMock.mockResolvedValueOnce(mockJson({ session_id: "x", ord: 0 }, 201));
    const store = makeStore();
    store.__setCacheForTests([
      {
        id: "x",
        started_at: 0,
        ended_at: null,
        finals: [],
        action_runs: [],
      },
    ]);
    await store.appendFinal("x", { text: "hi", start_ms: 0, end_ms: 100 });
    expect(store.list()[0].finals).toHaveLength(1);
  });

  it("appendFinal leaves the cache untouched when the API returns non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(mockJson({ detail: "broken" }, 500));
    const errors: { op: string; sessionId?: string }[] = [];
    const store = new HistoryStore({
      backendUrl: () => "http://test",
      onError: (_e, ctx) => errors.push(ctx),
    });
    store.__setCacheForTests([
      { id: "x", started_at: 0, ended_at: null, finals: [], action_runs: [] },
    ]);
    await expect(
      store.appendFinal("x", { text: "hi", start_ms: 0, end_ms: 1 }),
    ).rejects.toThrow(/500/);
    expect(store.list()[0].finals).toHaveLength(0);
    expect(errors).toEqual([{ op: "appendFinal", sessionId: "x" }]);
  });

  it("deleteSession removes from cache + DELETEs; rolls back on failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const store = makeStore();
    store.__setCacheForTests([
      { id: "a", started_at: 0, ended_at: null, finals: [], action_runs: [] },
      { id: "b", started_at: 1, ended_at: null, finals: [], action_runs: [] },
    ]);
    await store.deleteSession("a");
    expect(store.list().map((s) => s.id)).toEqual(["b"]);

    // Failure path: rollback
    fetchMock.mockResolvedValueOnce(mockJson({ detail: "boom" }, 500));
    await expect(store.deleteSession("b")).rejects.toThrow();
    expect(store.list().map((s) => s.id)).toEqual(["b"]); // restored
  });

  it("appendActionRun POSTs to /runs and adds to cache on success", async () => {
    fetchMock.mockResolvedValueOnce(mockJson({ id: 1 }, 201));
    const store = makeStore();
    store.__setCacheForTests([
      { id: "s", started_at: 0, ended_at: null, finals: [], action_runs: [] },
    ]);
    await store.appendActionRun("s", {
      action_id: "polish",
      prompt: "p",
      answer: "a",
      ran_at: 42,
    });
    // The cache stamps the server-assigned id alongside the input fields so
    // future deleteRun(sessionId, runId) calls can target the row.
    expect(store.list()[0].action_runs).toEqual([
      { id: 1, action_id: "polish", prompt: "p", answer: "a", ran_at: 42 },
    ]);
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe("http://test/v1/sessions/s/runs");
  });

  it("stopSession PATCHes ended_at + duration_ms", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson(
        {
          id: "s",
          started_at: 0,
          ended_at: 5,
          mode: "batch",
          audio_path: null,
          audio_mime_type: null,
          audio_size_bytes: null,
          duration_ms: 5,
          finals: [],
          action_runs: [],
        },
        200,
      ),
    );
    const store = makeStore();
    store.__setCacheForTests([
      { id: "s", started_at: 0, ended_at: null, finals: [], action_runs: [] },
    ]);
    await store.stopSession("s");
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toHaveProperty("ended_at");
    expect(body).toHaveProperty("duration_ms");
    expect(store.list()[0].ended_at).not.toBeNull();
  });

  it("uploadSessionAudio POSTs multipart and stamps audio_saved into cache", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson(
        {
          audio_path: "data/audio/s.webm",
          audio_size_bytes: 4,
          audio_mime_type: "audio/webm",
        },
        200,
      ),
    );
    const store = makeStore();
    store.__setCacheForTests([
      { id: "s", started_at: 0, ended_at: null, finals: [], action_runs: [] },
    ]);
    await store.uploadSessionAudio("s", new Blob([new Uint8Array([1, 2, 3, 4])]), "audio/webm");
    expect(store.list()[0].audio_saved).toBe(true);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe("http://test/v1/sessions/s/audio");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("bulkClearAudio DELETEs /v1/sessions/audio and flips audio_saved off", async () => {
    fetchMock.mockResolvedValueOnce(mockJson({ deleted_count: 2 }, 200));
    const store = makeStore();
    store.__setCacheForTests([
      {
        id: "a",
        started_at: 0,
        ended_at: null,
        finals: [],
        action_runs: [],
        audio_saved: true,
      },
      {
        id: "b",
        started_at: 1,
        ended_at: null,
        finals: [],
        action_runs: [],
        audio_saved: true,
      },
    ]);
    const count = await store.bulkClearAudio();
    expect(count).toBe(2);
    expect(store.list().every((s) => s.audio_saved === false)).toBe(true);
  });

  it("setRetention caps the in-memory list to N", () => {
    const store = makeStore();
    const records: SessionRecord[] = Array.from({ length: 25 }).map((_, i) => ({
      id: `r${i}`,
      started_at: i,
      ended_at: null,
      finals: [],
      action_runs: [],
    }));
    store.__setCacheForTests(records);
    expect(store.list()).toHaveLength(25);
    store.setRetention(10);
    expect(store.list()).toHaveLength(10);
  });
});

describe("HistoryStore.deleteRun", () => {
  let fetchMock: ReturnType<typeof import("vitest").vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  function seed(store: HistoryStore): SessionRecord {
    const record: SessionRecord = {
      id: "s",
      started_at: 0,
      ended_at: 100,
      finals: [],
      action_runs: [
        { id: 1, action_id: "a", prompt: "p", answer: "r1", ran_at: 1 },
        { id: 2, action_id: "a", prompt: "p", answer: "r2", ran_at: 2 },
        { id: 3, action_id: "a", prompt: "p", answer: "r3", ran_at: 3 },
      ],
    };
    store.__setCacheForTests([record]);
    return record;
  }

  it("204 prunes the run from the cache", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const onError = vi.fn();
    const store = new HistoryStore({
      backendUrl: () => "http://test",
      onError,
    });
    seed(store);

    await store.deleteRun("s", 2);

    const ids = store.list()[0].action_runs.map((r) => r.id);
    expect(ids).toEqual([1, 3]);
    expect(onError).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit | undefined)?.method).toBe("DELETE");
  });

  it("404 leaves the cache intact AND fires onError", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "run not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const onError = vi.fn();
    const store = new HistoryStore({
      backendUrl: () => "http://test",
      onError,
    });
    seed(store);

    await expect(store.deleteRun("s", 2)).rejects.toMatchObject({
      status: 404,
    });

    const ids = store.list()[0].action_runs.map((r) => r.id);
    expect(ids).toEqual([1, 2, 3]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("network error leaves cache intact AND fires onError", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const onError = vi.fn();
    const store = new HistoryStore({
      backendUrl: () => "http://test",
      onError,
    });
    seed(store);

    await expect(store.deleteRun("s", 2)).rejects.toThrow();

    expect(store.list()[0].action_runs.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
