import { describe, expect, it } from "vitest";

import {
  overlaySpeakers,
  type DiarizeTurn,
  type TranscriptSegment,
} from "./speaker-overlay";

describe("overlaySpeakers", () => {
  it("assigns the speaker of the single overlapping turn", () => {
    const segments: TranscriptSegment[] = [{ start: 0, end: 2, text: "hi" }];
    const turns: DiarizeTurn[] = [{ start: 0, end: 2, speaker: "A" }];

    expect(overlaySpeakers(segments, turns)).toEqual([
      { start: 0, end: 2, text: "hi", speaker: "A" },
    ]);
  });

  it("picks the speaker with the greatest overlap", () => {
    const segments: TranscriptSegment[] = [{ start: 0, end: 10, text: "long" }];
    const turns: DiarizeTurn[] = [
      { start: 0, end: 3, speaker: "A" }, // overlap 3
      { start: 3, end: 10, speaker: "B" }, // overlap 7 → wins
    ];

    const result = overlaySpeakers(segments, turns);
    expect(result[0].speaker).toBe("B");
  });

  it("returns null on a tie between two different speakers", () => {
    const segments: TranscriptSegment[] = [{ start: 0, end: 10, text: "split" }];
    const turns: DiarizeTurn[] = [
      { start: 0, end: 5, speaker: "A" }, // overlap 5
      { start: 5, end: 10, speaker: "B" }, // overlap 5 → tie
    ];

    expect(overlaySpeakers(segments, turns)[0].speaker).toBeNull();
  });

  it("returns null when no turn overlaps the segment", () => {
    const segments: TranscriptSegment[] = [{ start: 0, end: 2, text: "alone" }];
    const turns: DiarizeTurn[] = [{ start: 5, end: 8, speaker: "A" }];

    expect(overlaySpeakers(segments, turns)[0].speaker).toBeNull();
  });

  it("returns an empty array for empty segments", () => {
    const turns: DiarizeTurn[] = [{ start: 0, end: 2, speaker: "A" }];
    expect(overlaySpeakers([], turns)).toEqual([]);
  });

  it("assigns null to every segment when there are no turns", () => {
    const segments: TranscriptSegment[] = [
      { start: 0, end: 2, text: "one" },
      { start: 2, end: 4, text: "two" },
    ];

    const result = overlaySpeakers(segments, []);
    expect(result.map((s) => s.speaker)).toEqual([null, null]);
  });

  it("does not mutate the input segments", () => {
    const segments: TranscriptSegment[] = [{ start: 0, end: 2, text: "hi" }];
    const turns: DiarizeTurn[] = [{ start: 0, end: 2, speaker: "A" }];

    overlaySpeakers(segments, turns);
    expect(segments[0]).not.toHaveProperty("speaker");
  });

  it("preserves the segment's words when present", () => {
    const segments: TranscriptSegment[] = [
      {
        start: 0,
        end: 2,
        text: "hi there",
        words: [
          { word: "hi", start: 0, end: 1 },
          { word: "there", start: 1, end: 2 },
        ],
      },
    ];
    const turns: DiarizeTurn[] = [{ start: 0, end: 2, speaker: "A" }];

    const result = overlaySpeakers(segments, turns);
    expect(result[0].words).toEqual(segments[0].words);
    expect(result[0].speaker).toBe("A");
  });
});
