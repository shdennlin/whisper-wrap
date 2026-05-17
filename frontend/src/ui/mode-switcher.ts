/**
 * iOS-style segmented control for switching between Batch and Live capture
 * modes. Disabled while a recording is in progress (the host caller toggles
 * `setDisabled(true)` during capture so users cannot switch mid-session).
 */

import type { CaptureMode } from "../capture/mode-store";

const LABELS: Record<CaptureMode, string> = {
  batch: "Batch",
  live: "Live",
};

export interface ModeSwitcherOptions {
  root: HTMLElement;
  initial: CaptureMode;
  onChange: (mode: CaptureMode) => void;
}

export class ModeSwitcher {
  private current: CaptureMode;
  private buttons: Record<CaptureMode, HTMLButtonElement>;

  constructor(private readonly opts: ModeSwitcherOptions) {
    this.current = opts.initial;
    opts.root.classList.add("segmented");
    opts.root.setAttribute("role", "radiogroup");
    opts.root.setAttribute("aria-label", "Capture mode");

    this.buttons = {
      batch: this.makeButton("batch"),
      live: this.makeButton("live"),
    };
    opts.root.append(this.buttons.batch, this.buttons.live);
    this.syncPressedState();
  }

  setDisabled(disabled: boolean): void {
    this.buttons.batch.disabled = disabled;
    this.buttons.live.disabled = disabled;
  }

  getMode(): CaptureMode {
    return this.current;
  }

  private makeButton(mode: CaptureMode): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = LABELS[mode];
    b.setAttribute("role", "radio");
    b.dataset.mode = mode;
    b.addEventListener("click", () => {
      if (this.current === mode) return;
      this.current = mode;
      this.syncPressedState();
      this.opts.onChange(mode);
    });
    return b;
  }

  private syncPressedState(): void {
    for (const m of ["batch", "live"] as CaptureMode[]) {
      this.buttons[m].setAttribute(
        "aria-pressed",
        m === this.current ? "true" : "false",
      );
      this.buttons[m].setAttribute(
        "aria-checked",
        m === this.current ? "true" : "false",
      );
    }
  }
}
