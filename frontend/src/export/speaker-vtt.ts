/**
 * Speaker-aware WebVTT export. Cue text is prefixed with `[SPEAKER_xx] `.
 *
 * VTT differs from SRT only in the timestamp millisecond separator (`.` vs
 * `,`) and the `WEBVTT` header; speaker tagging is identical.
 */

import type { Segment } from "../meeting/types";
import { formatTimestampSeconds } from "./speaker-srt";

export function exportSpeakerVtt(segments: ReadonlyArray<Segment>): string {
  if (segments.length === 0) return "WEBVTT\n\n";
  const parts: string[] = [];
  for (const s of segments) {
    parts.push(
      `${formatTimestampSeconds(s.start, ".")} --> ${formatTimestampSeconds(s.end, ".")}\n` +
        `[${s.speaker}] ${s.text}\n`,
    );
  }
  return "WEBVTT\n\n" + parts.join("\n") + "\n";
}
