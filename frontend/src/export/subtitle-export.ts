/**
 * Client-side subtitle export (SRT / VTT / TXT) from a session's finals.
 *
 * Mirrors the server-side `app/services/subtitle_format.py` byte-for-byte so
 * the user can either:
 *   - Export from the PWA history panel (this module), or
 *   - POST audio to `/v1/audio/transcriptions?response_format=srt|vtt` and
 *     get the same bytes from the backend.
 */

export interface FinalCue {
  text: string;
  start_ms: number;
  end_ms: number;
}

export function exportSrt(finals: ReadonlyArray<FinalCue>): string {
  if (finals.length === 0) return "";
  const parts: string[] = [];
  finals.forEach((f, idx) => {
    parts.push(
      `${idx + 1}\n` +
        `${formatTimestampMs(f.start_ms, ",")} --> ${formatTimestampMs(f.end_ms, ",")}\n` +
        `${f.text}\n`,
    );
  });
  return parts.join("\n") + "\n";
}

export function exportVtt(finals: ReadonlyArray<FinalCue>): string {
  if (finals.length === 0) return "WEBVTT\n\n";
  const parts: string[] = [];
  for (const f of finals) {
    parts.push(
      `${formatTimestampMs(f.start_ms, ".")} --> ${formatTimestampMs(f.end_ms, ".")}\n` +
        `${f.text}\n`,
    );
  }
  return "WEBVTT\n\n" + parts.join("\n") + "\n";
}

export function exportTxt(finals: ReadonlyArray<FinalCue>): string {
  return finals.map((f) => f.text).join("\n");
}

function formatTimestampMs(totalMs: number, msSeparator: string): string {
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
