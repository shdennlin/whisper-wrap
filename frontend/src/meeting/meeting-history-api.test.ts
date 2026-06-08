/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMeeting,
  deleteMeeting,
  getMeeting,
  listMeetings,
  patchMeetingSpeakerNames,
} from "./meeting-history-api";
import type { MeetingResult } from "./types";

const SAMPLE_RESULT: MeetingResult = {
  language: "en",
  duration_seconds: 5,
  speakers: ["SPEAKER_00"],
  segments: [{ speaker: "SPEAKER_00", start: 0, end: 5, text: "hi" }],
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe("meeting-history-api", () => {
  it("listMeetings serialises limit + before_ms into query params", async () => {
    const fn = vi.fn(async () =>
      mockResponse({ meetings: [], next_before_ms: null }),
    );
    globalThis.fetch = fn as typeof fetch;
    await listMeetings({ limit: 50, before_ms: 1234 });
    expect(fn.mock.calls[0][0]).toContain("limit=50");
    expect(fn.mock.calls[0][0]).toContain("before_ms=1234");
  });

  it("listMeetings omits the query string when no opts supplied", async () => {
    const fn = vi.fn(async () =>
      mockResponse({ meetings: [], next_before_ms: null }),
    );
    globalThis.fetch = fn as typeof fetch;
    await listMeetings();
    expect(fn.mock.calls[0][0]).toBe("/v1/meetings");
  });

  it("getMeeting returns null on 404 (vs throwing)", async () => {
    const fn = vi.fn(async () =>
      mockResponse({ detail: "meeting not found" }, { ok: false, status: 404 }),
    );
    globalThis.fetch = fn as typeof fetch;
    const out = await getMeeting("missing");
    expect(out).toBeNull();
  });

  it("getMeeting throws on non-404 errors", async () => {
    const fn = vi.fn(async () =>
      mockResponse({ detail: "boom" }, { ok: false, status: 500 }),
    );
    globalThis.fetch = fn as typeof fetch;
    await expect(getMeeting("any")).rejects.toThrow(/HTTP 500/);
  });

  it("createMeeting POSTs JSON body and returns the row", async () => {
    const fn = vi.fn(async () =>
      mockResponse({
        id: "x",
        created_at: 100,
        filename: "f.m4a",
        duration_seconds: 5,
        language: "en",
        speakers_count: 1,
        result: SAMPLE_RESULT,
        speaker_names: {},
        status: "done",
      }),
    );
    globalThis.fetch = fn as typeof fetch;
    const out = await createMeeting({
      id: "x",
      filename: "f.m4a",
      result: SAMPLE_RESULT,
    });
    expect(out.id).toBe("x");
    expect(fn.mock.calls[0][0]).toBe("/v1/meetings");
    const init = fn.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toContain('"id":"x"');
  });

  it("patchMeetingSpeakerNames sends only the speaker_names field", async () => {
    const fn = vi.fn(async () =>
      mockResponse({
        id: "x",
        created_at: 0,
        filename: "f",
        duration_seconds: null,
        language: null,
        speakers_count: null,
        result: SAMPLE_RESULT,
        speaker_names: { SPEAKER_00: "Alice" },
        status: "done",
      }),
    );
    globalThis.fetch = fn as typeof fetch;
    await patchMeetingSpeakerNames("x", { SPEAKER_00: "Alice" });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(
      JSON.stringify({ speaker_names: { SPEAKER_00: "Alice" } }),
    );
  });

  it("deleteMeeting tolerates 404 (idempotent contract)", async () => {
    const fn = vi.fn(async () =>
      mockResponse({}, { ok: false, status: 404 }),
    );
    globalThis.fetch = fn as typeof fetch;
    await expect(deleteMeeting("missing")).resolves.toBeUndefined();
  });
});
