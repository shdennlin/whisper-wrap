/**
 * Speaker-aware plain-text exports.
 *
 * Two variants:
 *
 *   - `exportSpeakerTxt`: script-style — one paragraph per speaker turn
 *     with the speaker label on its own line and the merged text below.
 *     No timestamps. Best for "I just want to read it" / paste-into-email
 *     workflows.
 *
 *   - `exportSpeakerTxtChat`: chat-style — `[MM:SS] SPEAKER: text` per
 *     turn. Timestamps make it scan like a meeting log; mirrors the
 *     Chat view-mode in the UI. Matches what most LLMs / note-taking
 *     tools expect.
 *
 * Both variants collapse consecutive same-speaker segments into one
 * turn. The Meeting Mode page is expected to pass `renamedSegments`
 * (with `speaker` already replaced by the user's display name) so the
 * exporters stay locale-agnostic.
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

/** `[MM:SS]` chat-log timestamp — matches Chat view-mode formatting. */
function formatChatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}]`;
}

export function exportSpeakerTxtChat(
  segments: ReadonlyArray<Segment>,
): string {
  if (segments.length === 0) return "";
  const lines: string[] = [];
  let currentSpeaker: string | null = null;
  let currentTexts: string[] = [];
  let turnStart = 0;

  const flush = () => {
    if (currentSpeaker !== null && currentTexts.length > 0) {
      lines.push(
        `${formatChatTime(turnStart)} ${currentSpeaker}: ${currentTexts.join(" ").trim()}`,
      );
    }
  };

  for (const seg of segments) {
    if (seg.speaker !== currentSpeaker) {
      flush();
      currentSpeaker = seg.speaker;
      currentTexts = [seg.text.trim()];
      turnStart = seg.start;
    } else {
      currentTexts.push(seg.text.trim());
    }
  }
  flush();
  return lines.join("\n") + "\n";
}
