/**
 * One-click capture card that morphs in place between four states:
 *
 *   idle        — body click → onStart()
 *   recording   — body click → onStop() (save & transcribe);
 *                 ⏸ click → onPauseResume(); ✕ click → onDiscard()
 *   paused      — body click → onStop(); ▶ click → onPauseResume();
 *                 ✕ click → onDiscard()
 *   processing  — disabled spinner while awaiting transcribe response
 *
 * The same DOM node carries the recording state so the user never has to
 * track a separate "active" surface. Inner control clicks stopPropagation so
 * they don't also fire the body's start/stop handler.
 */

import type { CaptureMode } from "../capture/mode-store";
import { t } from "../i18n";

export type ModeCardState = "idle" | "recording" | "paused" | "processing";

export interface ModeCardOptions {
  mode: CaptureMode;
  icon: string;
  label: string;
  description: string;
  /** Should the pause button show in this mode? (false for Live.) */
  pauseSupported?: boolean;
  onStart: () => void;
  onStop: () => void;
  onPauseResume: () => void;
  onDiscard: () => void;
}

export class ModeCard {
  public readonly root: HTMLButtonElement;
  private iconEl: HTMLSpanElement;
  private label: HTMLSpanElement;
  private desc: HTMLSpanElement;
  private timer: HTMLSpanElement;
  private controls: HTMLDivElement;
  private pauseBtn: HTMLButtonElement;
  private discardBtn: HTMLButtonElement;
  private state: ModeCardState = "idle";
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private timerOriginMs = 0;
  /** Accumulated active ms across pauses; the live segment is timer-driven. */
  private accumulatedMs = 0;

  constructor(private readonly opts: ModeCardOptions) {
    this.root = document.createElement("button");
    this.root.type = "button";
    this.root.className = "mode-card";
    this.root.dataset.mode = opts.mode;
    this.root.dataset.state = "idle";

    this.iconEl = document.createElement("span");
    this.iconEl.className = "icon";
    this.iconEl.textContent = opts.icon;

    const info = document.createElement("span");
    info.className = "info";
    this.label = document.createElement("span");
    this.label.className = "label";
    this.label.textContent = opts.label;
    this.desc = document.createElement("span");
    this.desc.className = "desc";
    this.desc.textContent = opts.description;
    this.timer = document.createElement("span");
    this.timer.className = "timer";
    this.timer.textContent = "0:00.0";
    info.append(this.label, this.desc, this.timer);

    this.controls = document.createElement("div");
    this.controls.className = "controls";
    this.pauseBtn = makeIconButton("⏸", t("modeCard.pause"));
    this.discardBtn = makeIconButton("✕", t("modeCard.discard"));
    this.discardBtn.classList.add("discard-btn");
    if (opts.pauseSupported !== false) {
      this.controls.appendChild(this.pauseBtn);
    }
    this.controls.appendChild(this.discardBtn);

    this.root.append(this.iconEl, info, this.controls);

    this.root.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".mode-card .controls button"))
        return;
      // Body click resets any pending discard-confirm so it doesn't lurk.
      this.cancelDiscardConfirm();
      if (this.state === "idle") this.opts.onStart();
      else if (this.state === "recording" || this.state === "paused")
        this.opts.onStop();
    });
    this.pauseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cancelDiscardConfirm();
      this.opts.onPauseResume();
    });
    this.discardBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.discardConfirming) {
        this.cancelDiscardConfirm();
        this.opts.onDiscard();
      } else {
        this.startDiscardConfirm();
      }
    });
    this.applyState();
  }

  private discardConfirming = false;
  private discardConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  private startDiscardConfirm(): void {
    this.discardConfirming = true;
    this.discardBtn.classList.add("is-confirming");
    this.discardBtn.textContent = t("modeCard.discardConfirm");
    this.discardBtn.title = t("modeCard.discardConfirmTitle");
    if (this.discardConfirmTimer !== null) clearTimeout(this.discardConfirmTimer);
    this.discardConfirmTimer = setTimeout(() => this.cancelDiscardConfirm(), 3000);
  }

  private cancelDiscardConfirm(): void {
    if (this.discardConfirmTimer !== null) {
      clearTimeout(this.discardConfirmTimer);
      this.discardConfirmTimer = null;
    }
    if (!this.discardConfirming) return;
    this.discardConfirming = false;
    this.discardBtn.classList.remove("is-confirming");
    this.discardBtn.textContent = "✕";
    this.discardBtn.title = t("modeCard.discard");
  }

  getState(): ModeCardState {
    return this.state;
  }

  setDisabled(disabled: boolean, title?: string): void {
    this.root.disabled = disabled;
    if (title !== undefined) this.root.title = title;
    else this.root.removeAttribute("title");
  }

  /** Move to `recording`. Resets the timer. */
  start(): void {
    this.state = "recording";
    this.accumulatedMs = 0;
    this.timerOriginMs = Date.now();
    this.timer.textContent = formatTimer(0);
    this.startTimer();
    this.applyState();
  }

  /** Toggle between recording and paused. Returns the resulting state. */
  togglePause(): ModeCardState {
    if (this.state === "recording") {
      this.accumulatedMs += Date.now() - this.timerOriginMs;
      this.stopTimer();
      this.state = "paused";
      this.timer.textContent = formatTimer(this.accumulatedMs);
    } else if (this.state === "paused") {
      this.timerOriginMs = Date.now();
      this.startTimer();
      this.state = "recording";
    }
    this.applyState();
    return this.state;
  }

  /**
   * Move to `processing`. Optional custom label replaces the default
   * processing label (e.g. modeCard.confirmingFinal for Live's
   * graceful-stop wait).
   */
  showProcessing(label?: string): void {
    this.state = "processing";
    this.stopTimer();
    this.timer.textContent = label ?? t("modeCard.processing");
    this.applyState();
  }

  /** Return to idle and re-enable the card. */
  reset(): void {
    this.state = "idle";
    this.accumulatedMs = 0;
    this.stopTimer();
    this.cancelDiscardConfirm();
    this.timer.textContent = "0:00.0";
    this.applyState();
  }

  private applyState(): void {
    this.root.dataset.state = this.state;
    if (this.state === "paused") {
      this.pauseBtn.textContent = "▶";
      this.pauseBtn.title = t("modeCard.resume");
    } else {
      this.pauseBtn.textContent = "⏸";
      this.pauseBtn.title = t("modeCard.pause");
    }
    this.root.setAttribute(
      "aria-label",
      this.state === "idle"
        ? t("modeCard.startAria", { label: this.opts.label })
        : this.state === "processing"
          ? t("modeCard.processingAria")
          : t("modeCard.stopAria", { label: this.opts.label }),
    );
  }

  private startTimer(): void {
    if (this.timerInterval !== null) return;
    this.timerInterval = setInterval(() => {
      const live = Date.now() - this.timerOriginMs;
      this.timer.textContent = formatTimer(this.accumulatedMs + live);
    }, 100);
  }

  private stopTimer(): void {
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }
}

function makeIconButton(symbol: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon-button";
  b.textContent = symbol;
  b.title = title;
  b.setAttribute("aria-label", title);
  return b;
}

export function formatTimer(elapsedMs: number): string {
  const tenths = Math.floor(elapsedMs / 100);
  const totalSec = Math.floor(tenths / 10);
  const decimal = tenths % 10;
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, "0")}.${decimal}`;
}
