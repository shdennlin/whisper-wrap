/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetClientFetch, setClientFetch } from "../api/client";
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

// The migrated module routes through the shared openapi-fetch client; we stub
// the client's ONE `fetch` seam and assert on the emitted Request (method, URL,
// body) — the design's "Preserve the test seam" replacement for the old
// per-call global `fetch` stub.
let requests: Request[];

function stub(body: unknown, status = 200) {
  setClientFetch(async (input) => {
    requests.push(input as Request);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

beforeEach(() => {
  requests = [];
});
afterEach(() => resetClientFetch());

const sampleRow = (over: Record<string, unknown> = {}) => ({
  id: "x",
  created_at: 100,
  filename: "f.m4a",
  duration_seconds: 5,
  language: "en",
  speakers_count: 1,
  result: SAMPLE_RESULT,
  speaker_names: {},
  starred: false,
  status: "done",
  ...over,
});

describe("meeting-history-api", () => {
  it("listMeetings serialises limit + before_ms into query params", async () => {
    stub({ meetings: [], next_before_ms: null });
    await listMeetings({ limit: 50, before_ms: 1234 });
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/v1/meetings");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("before_ms")).toBe("1234");
  });

  it("listMeetings omits the query string when no opts supplied", async () => {
    stub({ meetings: [], next_before_ms: null });
    await listMeetings();
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/v1/meetings");
    expect(url.search).toBe("");
  });

  it("getMeeting returns null on 404 (vs throwing)", async () => {
    stub({ detail: "meeting not found" }, 404);
    const out = await getMeeting("missing");
    expect(out).toBeNull();
    expect(new URL(requests[0].url).pathname).toBe("/v1/meetings/missing");
  });

  it("getMeeting throws on non-404 errors", async () => {
    stub({ detail: "boom" }, 500);
    await expect(getMeeting("any")).rejects.toThrow(/HTTP 500/);
  });

  it("createMeeting POSTs JSON body and returns the row", async () => {
    stub(sampleRow());
    const out = await createMeeting({
      id: "x",
      filename: "f.m4a",
      result: SAMPLE_RESULT,
    });
    expect(out.id).toBe("x");
    const req = requests[0];
    expect(new URL(req.url).pathname).toBe("/v1/meetings");
    expect(req.method).toBe("POST");
    expect(await req.clone().text()).toContain('"id":"x"');
  });

  it("patchMeetingSpeakerNames sends only the speaker_names field", async () => {
    stub(sampleRow({ speaker_names: { SPEAKER_00: "Alice" } }));
    await patchMeetingSpeakerNames("x", { SPEAKER_00: "Alice" });
    const req = requests[0];
    expect(req.method).toBe("PATCH");
    expect(new URL(req.url).pathname).toBe("/v1/meetings/x");
    expect(await req.clone().text()).toBe(
      JSON.stringify({ speaker_names: { SPEAKER_00: "Alice" } }),
    );
  });

  it("deleteMeeting tolerates 404 (idempotent contract)", async () => {
    stub({}, 404);
    await expect(deleteMeeting("missing")).resolves.toBeUndefined();
    expect(requests[0].method).toBe("DELETE");
  });
});
