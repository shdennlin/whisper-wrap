/**
 * Renders live caption events: a single greyed-italic partial slot (replaced
 * on every new partial) and an append-only list of confirmed black final cues
 * with `mm:ss` timestamps.
 */

export interface FinalCue {
  text: string;
  start_ms: number;
  end_ms: number;
}

export class TranscriptView {
  private partialEl: HTMLDivElement;
  private finalsEl: HTMLDivElement;

  constructor(public readonly root: HTMLElement) {
    this.root.classList.add("transcript-view");
    this.finalsEl = document.createElement("div");
    this.finalsEl.className = "transcript-finals";
    this.partialEl = document.createElement("div");
    this.partialEl.className = "transcript-partial";
    this.root.append(this.finalsEl, this.partialEl);
  }

  setPartial(text: string): void {
    this.partialEl.textContent = text;
    this.partialEl.classList.toggle("is-active", text.length > 0);
  }

  clearPartial(): void {
    this.setPartial("");
  }

  appendFinal(cue: FinalCue): void {
    const row = document.createElement("div");
    row.className = "transcript-final";
    const ts = document.createElement("span");
    ts.className = "transcript-ts";
    ts.textContent = formatMmSs(cue.start_ms);
    const text = document.createElement("span");
    text.className = "transcript-text";
    text.textContent = cue.text;
    row.append(ts, text);
    this.finalsEl.appendChild(row);
    // Clearing the partial keeps the visual contract: partial slot shows the
    // current in-flight utterance only; finals own the confirmed history.
    this.clearPartial();
  }

  clear(): void {
    this.finalsEl.replaceChildren();
    this.clearPartial();
  }

  getFinals(): ReadonlyArray<FinalCue> {
    // Reconstruct cues from the DOM so callers can build exports without
    // duplicating state. Keep this in sync with appendFinal's row shape.
    const result: FinalCue[] = [];
    for (const row of Array.from(this.finalsEl.children)) {
      const text = row.querySelector(".transcript-text")?.textContent ?? "";
      const ts = row.querySelector(".transcript-ts")?.textContent ?? "00:00";
      result.push({ text, start_ms: parseMmSs(ts), end_ms: parseMmSs(ts) });
    }
    return result;
  }
}

function formatMmSs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function parseMmSs(s: string): number {
  const [mm, ss] = s.split(":").map((p) => parseInt(p, 10) || 0);
  return (mm * 60 + ss) * 1000;
}
