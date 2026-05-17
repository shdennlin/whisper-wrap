/**
 * Active-recording UI: round stop button, mm:ss.s timer, mode label, and an
 * optional slot for the Live-mode connection indicator. Replaces the two
 * ModeCards while a recording is in progress.
 */

import type { CaptureMode } from "../capture/mode-store";

export type RecordingBarState = "recording" | "processing";

const MODE_LABELS: Record<CaptureMode, string> = {
  batch: "Batch 模式（錄完一次轉錄）",
  live: "Live 模式（即時字幕）",
};

export interface RecordingBarOptions {
  root: HTMLElement;
  onStop: () => void;
}

export class RecordingBar {
  private stopBtn: HTMLButtonElement;
  private dot: HTMLSpanElement;
  private timer: HTMLSpanElement;
  private modeLabel: HTMLSpanElement;
  public readonly slot: HTMLDivElement;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private state: RecordingBarState = "recording";

  constructor(private readonly opts: RecordingBarOptions) {
    opts.root.classList.add("recording-active");

    this.stopBtn = document.createElement("button");
    this.stopBtn.type = "button";
    this.stopBtn.className = "stop-btn";
    this.stopBtn.dataset.state = "recording";
    this.stopBtn.setAttribute("aria-label", "停止錄音");
    this.dot = document.createElement("span");
    this.dot.className = "dot";
    this.stopBtn.appendChild(this.dot);

    const info = document.createElement("div");
    info.className = "info";
    this.timer = document.createElement("span");
    this.timer.className = "timer";
    this.timer.textContent = "0:00.0";
    this.modeLabel = document.createElement("span");
    this.modeLabel.className = "mode-label";
    info.append(this.timer, this.modeLabel);

    this.slot = document.createElement("div");
    this.slot.className = "slot";

    opts.root.append(this.stopBtn, info, this.slot);
    this.stopBtn.addEventListener("click", () => {
      if (this.state === "recording") this.opts.onStop();
    });
  }

  /** Begin a fresh recording display; resets the timer to 0. */
  start(mode: CaptureMode): void {
    this.state = "recording";
    this.stopBtn.dataset.state = "recording";
    this.stopBtn.disabled = false;
    this.stopBtn.setAttribute("aria-label", "停止錄音");
    this.modeLabel.textContent = MODE_LABELS[mode];
    this.startedAt = Date.now();
    this.timer.textContent = formatTimer(0);
    this.timerInterval = setInterval(() => this.tick(), 100);
  }

  /** Show the upload spinner; called between stop and the transcribe response. */
  showProcessing(): void {
    this.state = "processing";
    this.stopBtn.dataset.state = "processing";
    this.stopBtn.disabled = true;
    this.stopBtn.setAttribute("aria-label", "處理中");
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.timer.textContent = "處理中…";
  }

  /** Hide the bar and clear any pending timers. */
  reset(): void {
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.state = "recording";
    this.stopBtn.dataset.state = "recording";
    this.stopBtn.disabled = false;
    this.timer.textContent = "0:00.0";
    this.modeLabel.textContent = "";
    this.slot.replaceChildren();
  }

  private tick(): void {
    this.timer.textContent = formatTimer(Date.now() - this.startedAt);
  }
}

// Re-declare the same formatter used by record-button (kept inline so the
// two components stay decoupled).
export function formatTimer(elapsedMs: number): string {
  const tenths = Math.floor(elapsedMs / 100);
  const totalSec = Math.floor(tenths / 10);
  const decimal = tenths % 10;
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, "0")}.${decimal}`;
}
