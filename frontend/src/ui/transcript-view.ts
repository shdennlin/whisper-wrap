/**
 * Renders capture results.
 *
 * Layout: a header bar (title + copy button), an append-only list of confirmed
 * final cues, and a greyed-italic partial slot replaced on every new partial.
 *
 * Each final carries a `kind`:
 *   - "live"  → prefixed with an `mm:ss` start-time column (the WS /listen
 *               server emits per-utterance timestamps)
 *   - "batch" → no timestamp column (POST /transcribe collapses the run into
 *               one final with start_ms=0, so a timestamp would always read
 *               "00:00" and just add visual noise)
 */

export type FinalKind = "live" | "batch";

export interface FinalCue {
  text: string;
  start_ms: number;
  end_ms: number;
  kind?: FinalKind;
}

export class TranscriptView {
  private partialEl: HTMLDivElement;
  private finalsEl: HTMLDivElement;
  private copyBtn: HTMLButtonElement;

  constructor(public readonly root: HTMLElement) {
    this.root.classList.add("transcript-view");

    const header = document.createElement("div");
    header.className = "transcript-header";
    const titleEl = document.createElement("span");
    titleEl.className = "transcript-title";
    titleEl.textContent = "逐字稿";
    this.copyBtn = document.createElement("button");
    this.copyBtn.type = "button";
    this.copyBtn.className = "transcript-copy";
    this.copyBtn.textContent = "複製";
    this.copyBtn.title = "複製目前的逐字稿";
    this.copyBtn.addEventListener("click", () => {
      void copyToClipboard(this.getText()).then((ok) => {
        this.copyBtn.textContent = ok ? "已複製 ✓" : "複製失敗";
        setTimeout(() => (this.copyBtn.textContent = "複製"), 1500);
      });
    });
    header.append(titleEl, this.copyBtn);

    this.finalsEl = document.createElement("div");
    this.finalsEl.className = "transcript-finals";
    this.partialEl = document.createElement("div");
    this.partialEl.className = "transcript-partial";
    this.root.append(header, this.finalsEl, this.partialEl);
  }

  /** Plain-text join of all current finals (newline-separated). */
  getText(): string {
    return this.getFinals().map((f) => f.text).join("\n");
  }

  setPartial(text: string): void {
    this.partialEl.textContent = text;
    this.partialEl.classList.toggle("is-active", text.length > 0);
  }

  /** Returns the in-flight partial text (empty when no partial is showing). */
  getPartial(): string {
    return this.partialEl.textContent ?? "";
  }

  clearPartial(): void {
    this.setPartial("");
  }

  appendFinal(cue: FinalCue): void {
    const row = document.createElement("div");
    row.className = "transcript-final";
    const kind: FinalKind = cue.kind ?? "live";
    row.dataset.kind = kind;
    if (kind === "live") {
      const ts = document.createElement("span");
      ts.className = "transcript-ts";
      ts.textContent = formatMmSs(cue.start_ms);
      row.appendChild(ts);
    }
    const text = document.createElement("span");
    text.className = "transcript-text";
    text.textContent = cue.text;
    row.appendChild(text);
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
      const kind = ((row as HTMLElement).dataset.kind as FinalKind) ?? "live";
      result.push({ text, start_ms: parseMmSs(ts), end_ms: parseMmSs(ts), kind });
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

/**
 * Best-effort clipboard write. Returns true on success. Falls back to the
 * legacy textarea + document.execCommand path when Clipboard API is blocked
 * (some browsers in non-HTTPS contexts) so the auto-copy still works on
 * localhost dev setups.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to textarea fallback
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
