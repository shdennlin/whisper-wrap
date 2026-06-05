/**
 * Tests for client-side SRT / VTT / TXT export (Decision 4 + Subtitle export
 * requirement).
 *
 * The canonical two-segment example is taken from
 * openspec/specs/pwa-listen-client/spec.md (SRT/VTT scenarios) and matches the
 * openai-compat backend's formatter output byte-for-byte.
 */

import { describe, it, expect } from "vitest";
import { exportSrt, exportVtt, exportTxt } from "./subtitle-export";

const TWO_SEGMENTS = [
  { text: "hello world.", start_ms: 0, end_ms: 2500 },
  { text: " how are you.", start_ms: 2500, end_ms: 6000 },
];

describe("exportSrt", () => {
  it("matches the spec example exactly", () => {
    expect(exportSrt(TWO_SEGMENTS)).toBe(
      "1\n" +
        "00:00:00,000 --> 00:00:02,500\n" +
        "hello world.\n" +
        "\n" +
        "2\n" +
        "00:00:02,500 --> 00:00:06,000\n" +
        " how are you.\n" +
        "\n",
    );
  });

  it("handles the one-hour boundary", () => {
    const out = exportSrt([{ text: "tick.", start_ms: 3599500, end_ms: 3600500 }]);
    expect(out).toContain("00:59:59,500 --> 01:00:00,500");
  });

  it("emits empty string for empty input", () => {
    expect(exportSrt([])).toBe("");
  });
});

describe("exportVtt", () => {
  it("matches the spec example exactly (period ms separator + WEBVTT header)", () => {
    expect(exportVtt(TWO_SEGMENTS)).toBe(
      "WEBVTT\n" +
        "\n" +
        "00:00:00.000 --> 00:00:02.500\n" +
        "hello world.\n" +
        "\n" +
        "00:00:02.500 --> 00:00:06.000\n" +
        " how are you.\n" +
        "\n",
    );
  });

  it("emits header-only body for empty input", () => {
    expect(exportVtt([])).toBe("WEBVTT\n\n");
  });
});

describe("exportTxt", () => {
  it("joins final texts with single newlines and no timestamps", () => {
    expect(exportTxt(TWO_SEGMENTS)).toBe("hello world.\n how are you.");
  });

  it("emits empty string for empty input", () => {
    expect(exportTxt([])).toBe("");
  });
});
