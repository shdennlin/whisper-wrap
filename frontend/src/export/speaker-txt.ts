/**
 * Speaker-aware plain-text export.
 *
 * Consecutive segments with the same `speaker` are merged into a single
 * `SPEAKER_xx:` paragraph (one paragraph per speaker turn). Speaker change
 * starts a new paragraph. This matches the contract documented in the
 * `meeting-diarization` spec.
 */

import type { Segment } from "../meeting/types";

export function exportSpeakerTxt(segments: ReadonlyArray<Segment>): string {
  if (segments.length === 0) return "";
  const paragraphs: string[] = [];
  let currentSpeaker: string | null = null;
  let currentTexts: string[] = [];

  const flush = () => {
    if (currentSpeaker !== null && currentTexts.length > 0) {
      paragraphs.push(`${currentSpeaker}:\n${currentTexts.join(" ").trim()}`);
    }
  };

  for (const seg of segments) {
    if (seg.speaker !== currentSpeaker) {
      flush();
      currentSpeaker = seg.speaker;
      currentTexts = [seg.text.trim()];
    } else {
      currentTexts.push(seg.text.trim());
    }
  }
  flush();
  return paragraphs.join("\n\n") + "\n";
}
