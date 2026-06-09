/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from "vitest";

import type { MeetingResult, Segment } from "./types";
import {
  buildPromptText,
  collapseToChatTurns,
  renderChatMode,
  renderDetailMode,
  type RenderOptions,
} from "./transcript-renderer";

function makeSegment(
  speaker: string,
  start: number,
  end: number,
  text: string,
): Segment {
  return { speaker, start, end, text } as Segment;
}

const SAMPLE: MeetingResult = {
  language: "en",
  duration_seconds: 30,
  speakers: ["SPEAKER_00", "SPEAKER_01"],
  segments: [
    makeSegment("SPEAKER_00", 0.0, 1.2, "Hello there."),
    makeSegment("SPEAKER_00", 1.2, 2.5, "Welcome to the meeting."),
    makeSegment("SPEAKER_00", 2.5, 4.0, "Today's agenda is short."),
    makeSegment("SPEAKER_01", 4.0, 6.0, "Thanks for having me."),
    makeSegment("SPEAKER_00", 6.0, 7.5, "Of course."),
  ],
};

const SPEAKER_COLORS = new Map([
  ["SPEAKER_00", "#ff0000"],
  ["SPEAKER_01", "#00ff00"],
]);

function makeOpts(overrides?: Partial<RenderOptions>): RenderOptions {
  return {
    speakerColors: SPEAKER_COLORS,
    displaySpeakerName: (raw) => raw,
    formatTime: (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`,
    cssSafe: (s) => s.replace(/[^a-zA-Z0-9_-]/g, "_"),
    seekTo: () => {},
    onRename: () => {},
    renameTooltip: "Rename speaker",
    ...overrides,
  };
}

describe("collapseToChatTurns", () => {
  it("merges consecutive same-speaker segments into one turn", () => {
    // SAMPLE: 3× SPEAKER_00 → 1× SPEAKER_01 → 1× SPEAKER_00 = 3 turns.
    const turns = collapseToChatTurns(SAMPLE.segments);
    expect(turns).toHaveLength(3);
    expect(turns[0].raw_speaker).toBe("SPEAKER_00");
    expect(turns[0].start).toBe(0.0);
    expect(turns[0].end).toBe(4.0); // end of LAST merged segment
    expect(turns[0].text).toContain("Hello there.");
    expect(turns[0].text).toContain("Welcome to the meeting.");
    expect(turns[0].text).toContain("Today's agenda is short.");
  });

  it("starts a new turn whenever the speaker changes", () => {
    const turns = collapseToChatTurns(SAMPLE.segments);
    expect(turns.map((t) => t.raw_speaker)).toEqual([
      "SPEAKER_00",
      "SPEAKER_01",
      "SPEAKER_00",
    ]);
  });

  it("handles an empty segment list", () => {
    expect(collapseToChatTurns([])).toEqual([]);
  });

  it("collapses a single-segment result into one turn", () => {
    const single = [makeSegment("SPEAKER_00", 0, 1, "Just one.")];
    const turns = collapseToChatTurns(single);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("Just one.");
  });
});

describe("renderChatMode", () => {
  it("renders one .chat-turn per collapsed turn (not per segment)", () => {
    const host = document.createElement("div");
    renderChatMode(host, SAMPLE, makeOpts());
    expect(host.querySelectorAll(".chat-turn")).toHaveLength(3);
    // First turn should carry the merged text from all 3 SPEAKER_00
    // segments.
    const first = host.querySelector(".chat-turn") as HTMLElement;
    expect(first.textContent).toContain("Hello there.");
    expect(first.textContent).toContain("Welcome to the meeting.");
    expect(first.textContent).toContain("Today's agenda is short.");
  });

  it("clicking a chat-turn calls seekTo with the turn's start time", () => {
    const host = document.createElement("div");
    const seekTo = vi.fn();
    renderChatMode(host, SAMPLE, makeOpts({ seekTo }));
    const turns = host.querySelectorAll<HTMLButtonElement>(".chat-turn");
    turns[1].click(); // SPEAKER_01 turn, start = 4.0
    expect(seekTo).toHaveBeenCalledTimes(1);
    expect(seekTo.mock.calls[0][0].start).toBe(4.0);
    expect(seekTo.mock.calls[0][0].speaker).toBe("SPEAKER_01");
  });

  it("renders the rename ✏️ as .segment-meta-edit (CSS hover-show reused)", () => {
    const host = document.createElement("div");
    const onRename = vi.fn();
    renderChatMode(host, SAMPLE, makeOpts({ onRename }));
    const edit = host.querySelector<HTMLElement>(
      ".chat-turn .segment-meta-edit",
    )!;
    expect(edit).toBeTruthy();
    edit.click();
    expect(onRename).toHaveBeenCalledWith("SPEAKER_00");
  });

  it("applies speaker color via --turn-speaker-color custom property", () => {
    const host = document.createElement("div");
    renderChatMode(host, SAMPLE, makeOpts());
    const first = host.querySelector(".chat-turn") as HTMLElement;
    expect(first.style.getPropertyValue("--turn-speaker-color")).toBe(
      "#ff0000",
    );
  });
});

describe("renderDetailMode", () => {
  it("renders one .transcript-segment per segment (no collapsing)", () => {
    const host = document.createElement("div");
    renderDetailMode(host, SAMPLE, makeOpts());
    expect(host.querySelectorAll(".transcript-segment")).toHaveLength(
      SAMPLE.segments.length,
    );
  });

  it("clicking a segment calls seekTo with that segment's start", () => {
    const host = document.createElement("div");
    const seekTo = vi.fn();
    renderDetailMode(host, SAMPLE, makeOpts({ seekTo }));
    const segs = host.querySelectorAll<HTMLButtonElement>(".transcript-segment");
    segs[3].click(); // SPEAKER_01 segment at 4.0
    expect(seekTo).toHaveBeenCalledTimes(1);
    expect(seekTo.mock.calls[0][0].start).toBe(4.0);
  });
});

describe("buildPromptText", () => {
  it("returns chat-format text (speaker: text per turn), no timestamps", () => {
    const out = buildPromptText(SAMPLE, (raw) => raw);
    // 3 turns → 3 lines, joined with newlines.
    expect(out.split("\n")).toHaveLength(3);
    expect(out).toContain("SPEAKER_00: Hello there. Welcome to the meeting.");
    expect(out).toContain("SPEAKER_01: Thanks for having me.");
    // No `[MM:SS]` prefix (that's for the TXT export, not the LLM prompt).
    expect(out).not.toMatch(/\[\d+:\d+\]/);
  });

  it("threads renamed speaker names into the prompt", () => {
    const out = buildPromptText(SAMPLE, (raw) =>
      raw === "SPEAKER_00" ? "Alice" : "Bob",
    );
    expect(out).toContain("Alice: Hello there.");
    expect(out).toContain("Bob: Thanks for having me.");
    expect(out).not.toContain("SPEAKER_00");
  });

  it("handles empty results", () => {
    const empty: MeetingResult = { ...SAMPLE, segments: [] };
    expect(buildPromptText(empty, (raw) => raw)).toBe("");
  });
});
