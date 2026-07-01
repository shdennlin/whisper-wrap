/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetClientFetch, setClientFetch } from "../api/client";
import {
  clearHistory,
  loadHistory,
  prime,
  recordHistory,
  type HistoryEntry,
} from "./history-store";
import type { MeetingResult } from "./types";

const SAMPLE_RESULT: MeetingResult = {
  language: "en",
  duration_seconds: 5,
  speakers: ["SPEAKER_00"],
  segments: [{ speaker: "SPEAKER_00", start: 0, end: 5, text: "hi" }],
};

const LEGACY_KEY = "whisper-wrap.meeting-history.v1";

// history-store persists through `meeting-history-api`, which now routes through
// the shared openapi-fetch client. We stub the client's ONE `fetch` seam and
// route by the emitted Request (method + pathname) — the "Preserve the test
// seam" replacement for the old global `fetch` stub.
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  clearHistory();
  localStorage.clear();
});
afterEach(() => resetClientFetch());

describe("prime + legacy migration", () => {
  it("seeds the cache from /v1/meetings when backend has rows", async () => {
    setClientFetch(async () =>
      json({
        meetings: [
          {
            id: "abc",
            created_at: 100,
            filename: "foo.m4a",
            duration_seconds: 12.0,
            language: "en",
            speakers_count: 2,
            result: SAMPLE_RESULT,
            speaker_names: {},
            starred: false,
            status: "done",
          },
        ],
        next_before_ms: null,
      }),
    );
    await prime();
    const cache = loadHistory();
    expect(cache).toHaveLength(1);
    expect(cache[0].job_id).toBe("abc");
    expect(cache[0].filename).toBe("foo.m4a");
    expect(cache[0].result).toEqual(SAMPLE_RESULT);
  });

  it("migrates legacy localStorage entries when backend is empty", async () => {
    // Seed legacy localStorage with two entries (one with a result,
    // one without — the latter should be skipped because the backend
    // POST requires a result).
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify([
        {
          job_id: "old1",
          filename: "old.m4a",
          audio_duration_seconds: 30,
          started_at: 1000,
          status: "done",
          result: SAMPLE_RESULT,
        },
        { job_id: "old2", filename: "no-result.m4a", started_at: 500 },
      ]),
    );

    const createCalls: unknown[] = [];
    const migratedRow = {
      id: "old1",
      created_at: 1000,
      filename: "old.m4a",
      duration_seconds: 30,
      language: "en",
      speakers_count: 1,
      result: SAMPLE_RESULT,
      speaker_names: {},
      starred: false,
      status: "done",
    };
    setClientFetch(async (input) => {
      const req = input as Request;
      const path = new URL(req.url).pathname;
      if (path === "/v1/meetings" && req.method === "POST") {
        createCalls.push(JSON.parse(await req.clone().text()));
        return json(migratedRow, 201);
      }
      // First listMeetings call: empty. Second listMeetings (post-
      // migration refresh): include the migrated row.
      const after = createCalls.length > 0;
      return json({
        meetings: after ? [migratedRow] : [],
        next_before_ms: null,
      });
    });

    await prime();

    // The legacy entry with a `result` was uploaded; the resultless
    // one was silently skipped (the backend rejects empty results).
    expect(createCalls).toHaveLength(1);
    expect((createCalls[0] as { id: string }).id).toBe("old1");
    // localStorage was cleared so we never re-migrate on subsequent
    // prime() calls (this is the idempotency contract).
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    // Cache reflects the post-migration backend state.
    expect(loadHistory().map((e) => e.job_id)).toEqual(["old1"]);
  });

  it("does NOT migrate when backend already has rows (backend wins)", async () => {
    // Legacy localStorage has data, but backend is non-empty (e.g.
    // user already migrated on a different device).
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify([
        {
          job_id: "stale",
          filename: "stale.m4a",
          audio_duration_seconds: 5,
          started_at: 999,
          status: "done",
          result: SAMPLE_RESULT,
        },
      ]),
    );

    setClientFetch(async (input) => {
      const req = input as Request;
      if (req.method === "POST") {
        throw new Error(
          "no POST should fire — backend already has rows, migration skipped",
        );
      }
      return json({
        meetings: [
          {
            id: "remote",
            created_at: 5000,
            filename: "remote.m4a",
            duration_seconds: 60,
            language: "en",
            speakers_count: 3,
            result: SAMPLE_RESULT,
            speaker_names: {},
            starred: false,
            status: "done",
          },
        ],
        next_before_ms: null,
      });
    });

    await prime();

    expect(loadHistory().map((e) => e.job_id)).toEqual(["remote"]);
    // Migration was skipped, so localStorage stays put (will be
    // re-evaluated on next prime if/when backend is ever empty).
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });

  it("recordHistory persists to backend and prepends to the cache", async () => {
    let posted: unknown = null;
    setClientFetch(async (input) => {
      const req = input as Request;
      const path = new URL(req.url).pathname;
      if (path === "/v1/meetings" && req.method === "POST") {
        posted = JSON.parse(await req.clone().text());
      }
      return json({
        id: "new",
        created_at: 100,
        filename: "n.m4a",
        duration_seconds: 5,
        language: "en",
        speakers_count: 1,
        result: SAMPLE_RESULT,
        speaker_names: {},
        starred: false,
        status: "done",
      });
    });

    const entry: HistoryEntry = {
      job_id: "new",
      filename: "n.m4a",
      audio_duration_seconds: 5,
      started_at: 100,
      result: SAMPLE_RESULT,
    };
    const after = await recordHistory(entry);
    expect((posted as { id: string }).id).toBe("new");
    expect(after[0].job_id).toBe("new");
  });
});
