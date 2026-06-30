/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from "vitest";

import type { MeetingResult, Segment, Word } from "./types";
import {
  alignWordsToText,
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
    // onRename now receives the speaker plus the name label to edit in place.
    expect(onRename).toHaveBeenCalledWith("SPEAKER_00", expect.any(HTMLElement));
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

function word(w: string, start: number, end: number): Word {
  return { word: w, start, end };
}

describe("alignWordsToText", () => {
  it("maps zh text with spaces back onto space-less words", () => {
    // The engine's word list drops inter-word spacing; alignment must
    // restore the original display text exactly.
    const chunks = alignWordsToText("7 月 1 號", [
      word("7", 6.9, 6.93),
      word("月", 6.94, 7.06),
      word("1", 7.06, 7.09),
      word("號", 7.26, 7.33),
    ])!;
    expect(chunks.map((c) => c.text).join("")).toBe("7 月 1 號");
    expect(chunks.filter((c) => c.word)).toHaveLength(4);
  });

  it("aligns plain English words", () => {
    const chunks = alignWordsToText("hello world.", [
      word("hello", 0, 0.4),
      word("world.", 0.5, 0.9),
    ])!;
    expect(chunks.map((c) => c.text).join("")).toBe("hello world.");
    expect(chunks[2].word?.start).toBe(0.5);
  });

  it("returns null when words don't match the text (graceful fallback)", () => {
    expect(alignWordsToText("completely different", [word("你好", 0, 1)])).toBeNull();
    // Leftover non-space text after the last word is also a mismatch.
    expect(alignWordsToText("hello world", [word("hello", 0, 1)])).toBeNull();
  });
});

describe("word-level seek", () => {
  const WORDS_SEGMENT: Segment = {
    speaker: "SPEAKER_00",
    start: 6.8,
    end: 8.2,
    text: "7 月 1 號",
    words: [
      word("7", 6.9, 6.93),
      word("月", 6.94, 7.06),
      word("1", 7.06, 7.09),
      word("號", 7.26, 7.33),
    ],
  };
  const RESULT: MeetingResult = {
    language: "zh",
    duration_seconds: 30,
    speakers: ["SPEAKER_00"],
    segments: [WORDS_SEGMENT, makeSegment("SPEAKER_00", 8.2, 9.0, "plain")],
  };

  it("detail mode renders a .segment-word span per timed word", () => {
    const host = document.createElement("div");
    renderDetailMode(host, RESULT, makeOpts());
    const spans = host.querySelectorAll<HTMLElement>(".segment-word");
    expect(spans).toHaveLength(4);
    expect(spans[1].textContent).toBe("月");
    expect(spans[1].dataset.start).toBe("6.94");
    // Visible text is unchanged — spacing preserved by alignment.
    const textEl = host.querySelector(".segment-text")!;
    expect(textEl.textContent).toBe("7 月 1 號");
  });

  it("clicking a word seeks to the word's start, not the segment's", () => {
    const host = document.createElement("div");
    const seekTo = vi.fn();
    renderDetailMode(host, RESULT, makeOpts({ seekTo }));
    const spans = host.querySelectorAll<HTMLElement>(".segment-word");
    spans[3].click(); // 號 @ 7.26
    expect(seekTo).toHaveBeenCalledTimes(1); // stopPropagation: segment handler must not double-fire
    expect(seekTo.mock.calls[0][0].start).toBe(7.26);
  });

  it("segments without words render as plain text (no spans)", () => {
    const host = document.createElement("div");
    renderDetailMode(host, RESULT, makeOpts());
    const segs = host.querySelectorAll(".transcript-segment");
    expect(segs[1].querySelectorAll(".segment-word")).toHaveLength(0);
    expect(segs[1].querySelector(".segment-text")!.textContent).toBe("plain");
  });

  it("chat mode keeps word spans across the same-speaker collapse", () => {
    const host = document.createElement("div");
    const seekTo = vi.fn();
    renderChatMode(host, RESULT, makeOpts({ seekTo }));
    // Both segments collapse into one turn; the worded one still has spans.
    const turns = host.querySelectorAll(".chat-turn");
    expect(turns).toHaveLength(1);
    const spans = turns[0].querySelectorAll<HTMLElement>(".segment-word");
    expect(spans).toHaveLength(4);
    expect(turns[0].querySelector(".chat-turn-text")!.textContent).toBe(
      "7 月 1 號 plain",
    );
    spans[0].click(); // 7 @ 6.9
    expect(seekTo).toHaveBeenCalledTimes(1);
    expect(seekTo.mock.calls[0][0].start).toBe(6.9);
  });

  it("falls back to plain text when words mismatch the text", () => {
    const broken: MeetingResult = {
      ...RESULT,
      segments: [{ ...WORDS_SEGMENT, text: "different text entirely" }],
    };
    const host = document.createElement("div");
    renderDetailMode(host, broken, makeOpts());
    expect(host.querySelectorAll(".segment-word")).toHaveLength(0);
    expect(host.querySelector(".segment-text")!.textContent).toBe(
      "different text entirely",
    );
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
