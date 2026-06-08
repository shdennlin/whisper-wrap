/**
 * One-click capture card that morphs in place between five states:
 *
 *   idle        — body click → onStart()
 *   recording   — body click → onStop() (save & transcribe);
 *                 ⏸ click → onPauseResume(); ✕ click → onDiscard()
 *   paused      — body click → onStop(); ▶ click → onPauseResume();
 *                 ✕ click → onDiscard()
 *   processing  — disabled spinner while awaiting transcribe response
 *   confirming  — file pre-upload: shows {filename · duration} + [Change]/[Start ▶]
 *                 (only reachable when acceptUploads:true and the user picks
 *                 a file or drops one onto the card)
 *
 * The same DOM node carries every state so the user never has to track a
 * separate "active" surface. Inner control clicks stopPropagation so they
 * don't also fire the body's start/stop handler.
 */

import type { CaptureMode } from "../capture/mode-store";
import { t } from "../i18n";

export type ModeCardState =
  | "idle"
  | "recording"
  | "paused"
  | "processing"
  | "confirming";

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
  /**
   * Enable file-upload affordance: 📁 button + drag-drop zone in idle state.
   * On pick/drop the card calls onFilePicked(file); the caller is expected
   * to compute duration then call showConfirming() to advance the card.
   */
  acceptUploads?: boolean;
  onFilePicked?: (file: File) => void;
  onUnsupportedFile?: () => void;
  onConfirmStart?: () => void;
  onConfirmChange?: () => void;
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
  private uploadBtn: HTMLButtonElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private confirmEl: HTMLDivElement | null = null;
  private confirmStartBtn: HTMLButtonElement | null = null;
  private confirmChangeBtn: HTMLButtonElement | null = null;
  private dragCounter = 0;
  private state: ModeCardState = "idle";
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private timerOriginMs = 0;
  /** Accumulated active ms across pauses; the live segment is timer-driven. */
  private accumulatedMs = 0;
  private processingStartedAt = 0;
  private processingLabel = "";
  private processingTickInterval: ReturnType<typeof setInterval> | null = null;

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

    if (opts.acceptUploads) {
      this.setupUploadAffordance();
    }

    this.root.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".mode-card .controls button"))
        return;
      if ((e.target as HTMLElement).closest(".mode-card .upload-btn")) return;
      if ((e.target as HTMLElement).closest(".mode-card .confirm-actions"))
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
   * graceful-stop wait). An elapsed-time counter starts ticking next to
   * the label so long-running transcriptions show progress instead of
   * looking frozen.
   */
  showProcessing(label?: string): void {
    this.state = "processing";
    this.stopTimer();
    this.processingLabel = label ?? t("modeCard.processing");
    this.processingStartedAt = Date.now();
    this.applyState();
    // Render the initial 0:00 immediately so the user sees the elapsed
    // counter from the first paint instead of waiting one tick. Then
    // refresh every second — seconds granularity is enough.
    this.renderProcessing();
    this.processingTickInterval = setInterval(() => this.renderProcessing(), 1000);
  }

  private renderProcessing(): void {
    const elapsedMs = Date.now() - this.processingStartedAt;
    const text = `${this.processingLabel} ${formatElapsedShort(elapsedMs)}`;
    this.timer.textContent = text;
    // Mirror onto the confirm-card Start button when an upload is in
    // flight — that's the only label visible to the user in upload mode
    // since .info is hidden via the :has() rule in style.css.
    if (this.confirmStartBtn) this.confirmStartBtn.textContent = text;
  }

  /**
   * Morph the card into the confirm view used by file-upload flows. The
   * caller is responsible for computing duration and passing a pre-formatted
   * label (e.g. `formatDuration(seconds)`).
   */
  showConfirming(filename: string, durationLabel: string): void {
    this.state = "confirming";
    this.stopTimer();
    this.cancelDiscardConfirm();
    this.ensureConfirmEl();
    if (this.confirmEl) {
      const fname = this.confirmEl.querySelector<HTMLSpanElement>(".confirm-filename");
      const dur = this.confirmEl.querySelector<HTMLSpanElement>(".confirm-duration");
      if (fname) fname.textContent = filename;
      if (dur) dur.textContent = durationLabel;
      this.confirmEl.hidden = false;
    }
    this.applyState();
  }

  /** Return to idle and re-enable the card. */
  reset(): void {
    this.state = "idle";
    this.accumulatedMs = 0;
    this.stopTimer();
    this.stopProcessingTick();
    this.cancelDiscardConfirm();
    this.timer.textContent = "0:00.0";
    if (this.confirmEl) this.confirmEl.hidden = true;
    // Clear the file-input value so re-picking the SAME file re-fires `change`.
    if (this.fileInput) this.fileInput.value = "";
    this.dragCounter = 0;
    this.root.classList.remove("drag-over");
    this.applyState();
  }

  private stopProcessingTick(): void {
    if (this.processingTickInterval !== null) {
      clearInterval(this.processingTickInterval);
      this.processingTickInterval = null;
    }
  }

  /** Programmatically open the file picker (used by Change button). */
  openFilePicker(): void {
    // Clear value first so re-picking the SAME file still fires `change`.
    // The browser otherwise treats "same file as last time" as a no-op.
    if (this.fileInput) this.fileInput.value = "";
    this.fileInput?.click();
  }

  private setupUploadAffordance(): void {
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "audio/*";
    this.fileInput.hidden = true;
    this.fileInput.addEventListener("change", (e) => {
      // Without stopPropagation, this `change` from the hidden input would
      // bubble up to the card root, where some listeners interpret a body
      // event as "start recording". Belt-and-braces; harmless if no one
      // cares about change events on the root.
      e.stopPropagation();
      const file = this.fileInput?.files?.[0];
      if (!file) return;
      this.handlePickedFile(file);
    });
    // CRITICAL: this.fileInput is appended as a child of this.root (an outer
    // <button>). When we call `this.fileInput.click()` programmatically the
    // browser dispatches a fresh `click` event on the input that bubbles up
    // to the outer button. Without stopPropagation here, the outer button's
    // body click handler fires `onStart()` and a recording starts right
    // after the file picker opens — visible to the user as "the upload
    // button and the Batch button got pressed at the same time".
    this.fileInput.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    this.uploadBtn = document.createElement("button");
    this.uploadBtn.type = "button";
    this.uploadBtn.className = "upload-btn";
    this.uploadBtn.textContent = "📁";
    this.uploadBtn.title = t("modeCard.batchUpload");
    this.uploadBtn.setAttribute("aria-label", t("modeCard.batchUpload"));
    this.uploadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.fileInput?.click();
    });

    this.root.append(this.uploadBtn, this.fileInput);

    // Drag-and-drop on the whole card. We use a counter to handle child
    // dragenter/leave events firing during traversal (otherwise the
    // `.drag-over` class flickers as the cursor moves across the card's
    // children). Only active in idle state — refused in recording/processing.
    this.root.addEventListener("dragenter", (e) => {
      if (this.state !== "idle") return;
      e.preventDefault();
      this.dragCounter += 1;
      this.root.classList.add("drag-over");
    });
    this.root.addEventListener("dragover", (e) => {
      if (this.state !== "idle") return;
      e.preventDefault();
      // Show the "copy" cursor so the user knows the drop will be accepted.
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    this.root.addEventListener("dragleave", () => {
      if (this.state !== "idle") return;
      this.dragCounter = Math.max(0, this.dragCounter - 1);
      if (this.dragCounter === 0) this.root.classList.remove("drag-over");
    });
    this.root.addEventListener("drop", (e) => {
      if (this.state !== "idle") return;
      e.preventDefault();
      this.dragCounter = 0;
      this.root.classList.remove("drag-over");
      const file = e.dataTransfer?.files?.[0];
      if (file) this.handlePickedFile(file);
    });
  }

  private handlePickedFile(file: File): void {
    // Be lenient on MIME — some platforms report empty `type` for audio
    // files; allow common audio extensions as a fallback so the user isn't
    // blocked when the OS hasn't filled in a proper media type.
    const okMime = file.type.startsWith("audio/");
    const okExt = /\.(wav|mp3|m4a|mp4|aac|ogg|opus|flac|webm|wma|amr)$/i.test(
      file.name,
    );
    if (!okMime && !okExt) {
      this.opts.onUnsupportedFile?.();
      if (this.fileInput) this.fileInput.value = "";
      return;
    }
    this.opts.onFilePicked?.(file);
  }

  private ensureConfirmEl(): void {
    if (this.confirmEl) return;
    this.confirmEl = document.createElement("div");
    this.confirmEl.className = "confirm-view";
    this.confirmEl.hidden = true;
    const meta = document.createElement("div");
    meta.className = "confirm-meta";
    const fname = document.createElement("span");
    fname.className = "confirm-filename";
    const sep = document.createElement("span");
    sep.className = "confirm-sep";
    sep.textContent = " · ";
    const dur = document.createElement("span");
    dur.className = "confirm-duration";
    meta.append(fname, sep, dur);

    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    this.confirmChangeBtn = document.createElement("button");
    this.confirmChangeBtn.type = "button";
    this.confirmChangeBtn.className = "btn-secondary";
    this.confirmChangeBtn.textContent = t("modeCard.confirmChange");
    this.confirmChangeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.onConfirmChange?.();
    });
    this.confirmStartBtn = document.createElement("button");
    this.confirmStartBtn.type = "button";
    this.confirmStartBtn.className = "btn-primary";
    this.confirmStartBtn.textContent = t("modeCard.confirmStart");
    this.confirmStartBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.onConfirmStart?.();
    });
    actions.append(this.confirmChangeBtn, this.confirmStartBtn);

    this.confirmEl.append(meta, actions);
    this.root.appendChild(this.confirmEl);
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
          : this.state === "confirming"
            ? t("modeCard.confirmingAria")
            : t("modeCard.stopAria", { label: this.opts.label }),
    );
    // When the confirm card is mounted, freeze its Start/Change buttons
    // during processing so the user can't double-submit or yank the file
    // out of an in-flight upload. The Start button label switches to
    // "Processing…" to make the disabled state self-explanatory; otherwise
    // the green Start button stays clickable-looking even when grayed.
    if (this.confirmStartBtn && this.confirmChangeBtn) {
      const inProcessing = this.state === "processing";
      this.confirmStartBtn.disabled = inProcessing;
      this.confirmChangeBtn.disabled = inProcessing;
      // Only seed the Start label in non-processing states. In processing,
      // renderProcessing() owns the textContent (it appends the elapsed
      // timer) and runs immediately after applyState in showProcessing —
      // setting "Processing…" here would just be overwritten 1ms later.
      if (!inProcessing) {
        this.confirmStartBtn.textContent = t("modeCard.confirmStart");
      }
    }
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

/**
 * MM:SS for under-an-hour spans, H:MM:SS when an hour or longer. Used by
 * the processing tick — no tenths because seconds granularity is enough
 * and reduces visual jitter.
 */
export function formatElapsedShort(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const ss = totalSec % 60;
  if (totalSec < 3600) {
    const mm = Math.floor(totalSec / 60);
    return `${mm}:${String(ss).padStart(2, "0")}`;
  }
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
