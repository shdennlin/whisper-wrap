/**
 * Large round record/stop button with three visual states:
 *
 *   idle        ↦ red dot inside a neutral ring (resting state)
 *   recording   ↦ red square inside a tinted-red ring, pulsing, with a live
 *                 mm:ss.s timer next to it
 *   processing  ↦ accent-coloured spinner (Batch mode awaiting /transcribe
 *                 response)
 *
 * The host caller decides which state to be in; this component renders the
 * state and notifies on click.
 */

export type RecordButtonState = "idle" | "recording" | "processing";

export interface RecordButtonOptions {
  root: HTMLElement;
  onClick: () => void;
}

export class RecordButton {
  private button: HTMLButtonElement;
  private dot: HTMLSpanElement;
  private timer: HTMLSpanElement;
  private state: RecordButtonState = "idle";
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  constructor(private readonly opts: RecordButtonOptions) {
    opts.root.classList.add("record-controls");

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "record-button";
    this.button.setAttribute("aria-label", "錄音");
    this.dot = document.createElement("span");
    this.dot.className = "dot";
    this.button.appendChild(this.dot);

    this.timer = document.createElement("span");
    this.timer.className = "record-timer";
    this.timer.textContent = "";

    opts.root.append(this.button, this.timer);
    this.button.addEventListener("click", () => this.opts.onClick());
    this.setState("idle");
  }

  setState(state: RecordButtonState): void {
    this.state = state;
    this.button.dataset.state = state;
    this.button.disabled = state === "processing";
    this.button.setAttribute(
      "aria-label",
      state === "recording" ? "停止錄音" : state === "processing" ? "處理中" : "開始錄音",
    );
    if (state === "recording") {
      this.startedAt = Date.now();
      this.timer.textContent = "0:00.0";
      this.timerInterval = setInterval(() => this.tick(), 100);
    } else {
      if (this.timerInterval !== null) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
      if (state === "processing") {
        this.timer.textContent = "處理中…";
      } else {
        this.timer.textContent = "";
      }
    }
  }

  getState(): RecordButtonState {
    return this.state;
  }

  private tick(): void {
    const elapsedMs = Date.now() - this.startedAt;
    this.timer.textContent = formatTimer(elapsedMs);
  }
}

export function formatTimer(elapsedMs: number): string {
  const tenths = Math.floor(elapsedMs / 100);
  const totalSec = Math.floor(tenths / 10);
  const decimal = tenths % 10;
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, "0")}.${decimal}`;
}
