import { describe, expect, it } from "vitest";
import type { Segment } from "../meeting/types";
import { exportSpeakerTxt } from "./speaker-txt";

function seg(speaker: string, text: string, start = 0, end = 1): Segment {
  return { speaker, start, end, text };
}

describe("exportSpeakerTxt", () => {
  it("groups three consecutive SPEAKER_00 segments into one paragraph", () => {
    const out = exportSpeakerTxt([
      seg("SPEAKER_00", "First sentence."),
      seg("SPEAKER_00", "Second sentence."),
      seg("SPEAKER_00", "Third sentence."),
    ]);
    expect(out.trim()).toBe(
      "SPEAKER_00:\nFirst sentence. Second sentence. Third sentence.",
    );
  });

  it("starts a new paragraph on speaker change", () => {
    const out = exportSpeakerTxt([
      seg("SPEAKER_00", "Hello."),
      seg("SPEAKER_00", "How are you?"),
      seg("SPEAKER_01", "I am fine."),
    ]);
    const paragraphs = out.split("\n\n").map((p) => p.trim());
    expect(paragraphs[0]).toBe("SPEAKER_00:\nHello. How are you?");
    expect(paragraphs[1]).toBe("SPEAKER_01:\nI am fine.");
  });

  it("alternates correctly across speakers", () => {
    const out = exportSpeakerTxt([
      seg("SPEAKER_00", "A1"),
      seg("SPEAKER_01", "B1"),
      seg("SPEAKER_00", "A2"),
      seg("SPEAKER_01", "B2"),
    ]);
    const paragraphs = out.split("\n\n").map((p) => p.trim());
    expect(paragraphs).toEqual([
      "SPEAKER_00:\nA1",
      "SPEAKER_01:\nB1",
      "SPEAKER_00:\nA2",
      "SPEAKER_01:\nB2",
    ]);
  });

  it("returns empty string for zero segments", () => {
    expect(exportSpeakerTxt([])).toBe("");
  });
});
