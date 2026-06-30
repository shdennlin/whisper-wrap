import { describe, expect, it, vi } from "vitest";

vi.mock("../storage/history-api-client", () => ({
  listSessions: vi.fn(async () => ({
    sessions: [
      {
        id: "s1",
        started_at: 100,
        ended_at: null,
        mode: "batch",
        audio_path: null,
        audio_mime_type: null,
        audio_size_bytes: null,
        duration_ms: 5000,
        title: "靈感",
        starred: true,
        project: null,
        category: "quick",
        finals: [
          {
            session_id: "s1",
            ord: 0,
            text: "  Hello   world ",
            start_ms: 0,
            end_ms: 1000,
            kind: "final",
          },
          {
            session_id: "s1",
            ord: 1,
            text: "this is a quick voice note",
            start_ms: 1000,
            end_ms: 2000,
            kind: "final",
          },
        ],
        action_runs: [],
      },
    ],
    next_before_ms: null,
  })),
}));

vi.mock("../meeting/meeting-history-api", () => ({
  listMeetings: vi.fn(async () => ({
    meetings: [
      {
        id: "m1",
        created_at: 200,
        filename: "standup.wav",
        duration_seconds: 60,
        language: "zh",
        speakers_count: 2,
        result: {},
        speaker_names: {},
        status: "done",
        title: null,
        starred: false,
        project: "Q3",
        category: "meeting",
      },
    ],
    next_before_ms: null,
  })),
}));

import { listItems } from "./items";

describe("listItems", () => {
  it("merges sessions + meetings newest-first with metadata", async () => {
    const items = await listItems();
    // m1 (200) is newer than s1 (100).
    expect(items.map((i) => i.id)).toEqual(["m1", "s1"]);

    expect(items[0]).toMatchObject({
      id: "m1",
      kind: "meeting",
      title: "standup.wav", // falls back to filename
      starred: false,
      project: "Q3",
      category: "meeting",
      durationMs: 60000,
    });
    expect(items[1]).toMatchObject({
      id: "s1",
      kind: "session",
      title: "靈感",
      starred: true,
      category: "quick",
      durationMs: 5000,
    });
  });

  it("derives a session preview from finals (trimmed, whitespace-collapsed)", async () => {
    const items = await listItems();
    const session = items.find((i) => i.id === "s1");
    expect(session?.preview).toBe("Hello world this is a quick voice note");
    // Meetings carry no eager transcript, so no preview.
    expect(items.find((i) => i.id === "m1")?.preview).toBeUndefined();
  });
});
