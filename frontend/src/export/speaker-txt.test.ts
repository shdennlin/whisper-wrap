import { describe, expect, it } from "vitest";
import type { Segment } from "../meeting/types";
import { exportSpeakerTxt, exportSpeakerTxtChat } from "./speaker-txt";

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

describe("exportSpeakerTxtChat", () => {
  it("emits `[MM:SS] SPEAKER: text` per merged turn", () => {
    const out = exportSpeakerTxtChat([
      seg("SPEAKER_00", "Hello.", 0, 1),
      seg("SPEAKER_00", "How are you?", 1, 2),
      seg("SPEAKER_01", "I am fine.", 75, 78),
    ]);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("[00:00] SPEAKER_00: Hello. How are you?");
    expect(lines[1]).toBe("[01:15] SPEAKER_01: I am fine.");
  });

  it("uses each turn's FIRST segment start (not last) for the timestamp", () => {
    const out = exportSpeakerTxtChat([
      seg("SPEAKER_00", "A1", 10, 12),
      seg("SPEAKER_00", "A2", 12, 15),
      seg("SPEAKER_00", "A3", 15, 20),
    ]);
    // One merged line, timestamp = first segment's start (10s = 0:10).
    expect(out.trim()).toBe("[00:10] SPEAKER_00: A1 A2 A3");
  });

  it("renamed speakers (passed in by caller) appear in the output", () => {
    // Caller pre-applies `displaySpeakerName` to each segment, so the
    // exporter just renders what it's given.
    const out = exportSpeakerTxtChat([
      seg("Alice", "Hi.", 0, 1),
      seg("Bob", "Hi back.", 1, 2),
    ]);
    expect(out).toContain("[00:00] Alice: Hi.");
    expect(out).toContain("[00:01] Bob: Hi back.");
  });

  it("returns empty string for zero segments", () => {
    expect(exportSpeakerTxtChat([])).toBe("");
  });
});
