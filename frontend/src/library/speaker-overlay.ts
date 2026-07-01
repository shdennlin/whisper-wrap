/**
 * Render-time overlay of diarization speaker turns onto transcript segments.
 *
 * Diarization runs on the raw audio and produces speaker *turns* on its own
 * timeline; the transcript is a separate list of *segments*. Decision D1/D3 of
 * the `detail-seekable-transcript` change keeps diarization audio-only and does
 * the join here, in the frontend, purely for display: each transcript segment
 * is annotated with the speaker of the turn it shares the most time with.
 *
 * This is a pure function — inputs are never mutated; a new array of new
 * segment objects is returned.
 */

/** A single word inside a transcript segment (optional, ASR-dependent). */
export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

/** A transcript segment on the transcript timeline. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

/** A diarization speaker turn on the audio timeline. */
export interface DiarizeTurn {
  start: number;
  end: number;
  speaker: string;
}

/** A transcript segment annotated with an overlaid speaker (or `null`). */
export type SpeakerSegment = TranscriptSegment & {
  speaker: string | null;
};

/**
 * Time the segment `[s.start, s.end]` and the turn `[t.start, t.end]` share.
 * Zero when they do not overlap.
 */
function overlap(segment: TranscriptSegment, turn: DiarizeTurn): number {
  return Math.max(
    0,
    Math.min(segment.end, turn.end) - Math.max(segment.start, turn.start),
  );
}

/**
 * Resolve the speaker for one segment: the turn with the single greatest
 * positive overlap wins. Returns `null` when no turn overlaps, or when the
 * maximum overlap is tied between two *different* speakers (D3).
 */
function resolveSpeaker(
  segment: TranscriptSegment,
  turns: DiarizeTurn[],
): string | null {
  let bestSpeaker: string | null = null;
  let bestOverlap = 0;
  let tied = false;

  for (const turn of turns) {
    const shared = overlap(segment, turn);
    if (shared <= 0) continue;

    if (shared > bestOverlap) {
      bestOverlap = shared;
      bestSpeaker = turn.speaker;
      tied = false;
    } else if (shared === bestOverlap && turn.speaker !== bestSpeaker) {
      tied = true;
    }
  }

  return tied ? null : bestSpeaker;
}

/**
 * Overlay speaker turns onto transcript segments by greatest time overlap.
 * Returns a NEW array of NEW segment objects; inputs are left untouched.
 */
export function overlaySpeakers(
  segments: TranscriptSegment[],
  turns: DiarizeTurn[],
): SpeakerSegment[] {
  return segments.map((segment) => ({
    ...segment,
    speaker: resolveSpeaker(segment, turns),
  }));
}
