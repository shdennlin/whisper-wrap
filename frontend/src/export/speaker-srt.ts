/**
 * Speaker-aware SRT export for the meeting analysis endpoint.
 *
 * Mirrors the cue format of `subtitle-export.ts::exportSrt` but prefixes each
 * cue's text with `[SPEAKER_xx] ` taken from the segment's `speaker` field.
 * Kept in a separate module so the existing exporter stays focused on the
 * single-speaker `FinalCue` shape.
 */

import type { Segment } from "../meeting/types";

export function exportSpeakerSrt(segments: ReadonlyArray<Segment>): string {
  if (segments.length === 0) return "";
  const parts: string[] = [];
  segments.forEach((s, idx) => {
    parts.push(
      `${idx + 1}\n` +
        `${formatTimestampSeconds(s.start, ",")} --> ${formatTimestampSeconds(s.end, ",")}\n` +
        `[${s.speaker}] ${s.text}\n`,
    );
  });
  return parts.join("\n") + "\n";
}

export function formatTimestampSeconds(
  totalSeconds: number,
  msSeparator: string,
): string {
  const totalMs = Math.round(totalSeconds * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return (
    `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}` +
    `${msSeparator}${pad(millis, 3)}`
  );
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}
