import { describe, expect, it } from "vitest";
import type { Segment } from "../meeting/types";
import { exportSpeakerVtt } from "./speaker-vtt";

const sampleSegments: Segment[] = [
  { speaker: "SPEAKER_00", start: 0.5, end: 4.18, text: "hello world" },
  { speaker: "SPEAKER_01", start: 5.0, end: 9.7, text: "goodbye world" },
];

describe("exportSpeakerVtt", () => {
  it("starts with WEBVTT header", () => {
    const out = exportSpeakerVtt(sampleSegments);
    expect(out.startsWith("WEBVTT\n\n")).toBe(true);
  });

  it("uses '.' as the millisecond separator (VTT spec) instead of SRT's ','", () => {
    const out = exportSpeakerVtt(sampleSegments);
    expect(out).toContain("00:00:00.500 --> 00:00:04.180");
    expect(out).not.toContain("00:00:00,500");
  });

  it("prefixes each cue text with [SPEAKER_xx]", () => {
    const out = exportSpeakerVtt(sampleSegments);
    expect(out).toContain("[SPEAKER_00] hello world");
    expect(out).toContain("[SPEAKER_01] goodbye world");
  });

  it("returns only the header for zero segments", () => {
    expect(exportSpeakerVtt([])).toBe("WEBVTT\n\n");
  });
});
