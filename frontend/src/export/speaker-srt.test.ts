import { describe, expect, it } from "vitest";
import type { Segment } from "../meeting/types";
import { exportSpeakerSrt } from "./speaker-srt";

const sampleSegments: Segment[] = [
  {
    speaker: "SPEAKER_00",
    start: 0.5,
    end: 4.18,
    text: "今天會議的主題是...",
  },
  {
    speaker: "SPEAKER_01",
    start: 5.0,
    end: 9.7,
    text: "但是我們需要考慮",
  },
];

describe("exportSpeakerSrt", () => {
  it("emits cues with [SPEAKER_xx] prefix and SRT timestamp format", () => {
    const out = exportSpeakerSrt(sampleSegments);
    expect(out).toContain("[SPEAKER_00] 今天會議的主題是...");
    expect(out).toContain("[SPEAKER_01] 但是我們需要考慮");
    expect(out).toContain("00:00:00,500 --> 00:00:04,180");
    expect(out).toContain("00:00:05,000 --> 00:00:09,700");
  });

  it("numbers cues starting at 1", () => {
    const out = exportSpeakerSrt(sampleSegments);
    const lines = out.split("\n");
    expect(lines[0]).toBe("1");
    expect(lines.includes("2")).toBe(true);
  });

  it("matches the spec example cue format byte-for-byte", () => {
    const single: Segment[] = [
      {
        speaker: "SPEAKER_01",
        start: 5.0,
        end: 9.7,
        text: "但是我們需要考慮",
      },
    ];
    expect(exportSpeakerSrt(single)).toBe(
      "1\n00:00:05,000 --> 00:00:09,700\n[SPEAKER_01] 但是我們需要考慮\n\n",
    );
  });

  it("returns empty string for zero segments", () => {
    expect(exportSpeakerSrt([])).toBe("");
  });
});
