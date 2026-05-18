/**
 * WaveformPlayer — canvas-based replay component for the history card.
 *
 * Renders a peaks waveform, a play / pause button, and a `m:ss / m:ss`
 * time readout. Click + drag-scrub on the canvas seeks by pixel position
 * (pointer events: a single tap seeks once, pointerdown + drag scrubs
 * continuously). The <audio> element is the time source; we tick at ~30 Hz
 * via requestAnimationFrame to move the cursor (timeupdate fires at
 * browser-dependent rates — design.md "Player state machine").
 *
 * The component decouples decoding via the constructor's `decode` option
 * so tests don't need a real AudioContext (happy-dom doesn't ship one).
 */

import { t } from "../i18n";
import type { StringKey } from "../i18n";

import { computePeaks } from "./waveform-peaks";

export type PlayerState =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "error";

export type PlayerInput =
  | { kind: "audio"; blob: Blob; mime_type: string; duration_ms: number }
  | { kind: "expired" }
  | { kind: "missing" };

interface PlayerOpts {
  root: HTMLElement;
  input: PlayerInput;
  /** Decouples decode from the real AudioContext (for tests). */
  decode?: (blob: Blob) => Promise<Float32Array>;
  /** Called once if decode rejects, with the original error. */
  onError?: (error: unknown) => void;
}

const DEFAULT_CANVAS_WIDTH = 320;
const DEFAULT_CANVAS_HEIGHT = 48;

export class WaveformPlayer {
  private readonly root: HTMLElement;
  private readonly input: PlayerInput;
  private readonly decodeFn: (blob: Blob) => Promise<Float32Array>;
  private readonly onError: (error: unknown) => void;

  private readonly canvas: HTMLCanvasElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly timeEl: HTMLSpanElement;
  private readonly labelEl: HTMLSpanElement;
  private readonly audioEl: HTMLAudioElement;

  private samples: Float32Array | null = null;
  private peaks: Array<[number, number]> | null = null;
  private _state: PlayerState = "idle";
  private rafId: number | null = null;
  private isScrubbing = false;

  // Bound handlers so destroy() can remove them.
  private readonly onCanvasPointerDown: (ev: PointerEvent) => void;
  private readonly onCanvasPointerMove: (ev: PointerEvent) => void;
  private readonly onCanvasPointerUp: (ev: PointerEvent) => void;
  private readonly onPlayClick: () => void;

  constructor(opts: PlayerOpts) {
    this.root = opts.root;
    this.input = opts.input;
    this.decodeFn = opts.decode ?? defaultDecode;
    this.onError = opts.onError ?? (() => {});

    this.root.classList.add("waveform-player");

    this.canvas = document.createElement("canvas");
    this.canvas.className = "waveform-canvas";
    this.canvas.width = DEFAULT_CANVAS_WIDTH;
    this.canvas.height = DEFAULT_CANVAS_HEIGHT;

    this.playBtn = document.createElement("button");
    this.playBtn.type = "button";
    this.playBtn.className = "waveform-play";
    this.playBtn.dataset.action = "play";
    this.playBtn.textContent = "▶";

    this.timeEl = document.createElement("span");
    this.timeEl.className = "waveform-time";
    this.timeEl.textContent = "0:00 / 0:00";

    this.labelEl = document.createElement("span");
    this.labelEl.className = "waveform-label";
    this.labelEl.textContent = "";

    this.audioEl = document.createElement("audio");
    this.audioEl.preload = "none";

    // Bound listeners — saved so destroy() can detach them cleanly.
    this.onCanvasPointerDown = (ev: PointerEvent): void =>
      this.handleCanvasPointerDown(ev);
    this.onCanvasPointerMove = (ev: PointerEvent): void =>
      this.handleCanvasPointerMove(ev);
    this.onCanvasPointerUp = (ev: PointerEvent): void =>
      this.handleCanvasPointerUp(ev);
    this.onPlayClick = (): void => {
      void this.handlePlayClick();
    };

    this.canvas.addEventListener("pointerdown", this.onCanvasPointerDown);
    this.canvas.addEventListener("pointermove", this.onCanvasPointerMove);
    this.canvas.addEventListener("pointerup", this.onCanvasPointerUp);
    this.canvas.addEventListener("pointercancel", this.onCanvasPointerUp);
    this.playBtn.addEventListener("click", this.onPlayClick);

    this.root.append(
      this.playBtn,
      this.canvas,
      this.timeEl,
      this.labelEl,
      this.audioEl,
    );

    this.renderInitial();
  }

  state(): PlayerState {
    return this._state;
  }

  async load(): Promise<void> {
    if (this.input.kind !== "audio") return;
    if (this._state === "loading") return;

    this.setState("loading");
    this.labelEl.textContent = t("audio.playerLoading" as StringKey);

    let samples: Float32Array;
    try {
      samples = await this.decodeFn(this.input.blob);
    } catch (err) {
      this.handleDecodeError(err);
      return;
    }

    this.samples = samples;
    this.renderPeaks();

    // Wire the audio element to the blob now that we've successfully decoded.
    // (We don't strictly need an object URL for happy-dom tests, but the real
    // browser needs it so play() works.)
    try {
      this.audioEl.src = URL.createObjectURL(this.input.blob);
    } catch {
      // Some test environments lack URL.createObjectURL — non-fatal.
    }

    this.labelEl.textContent = "";
    this.timeEl.textContent = `${formatMmSs(0)} / ${formatMmSs(this.input.duration_ms)}`;
    this.playBtn.disabled = false;
    this.setState("ready");
  }

  resize(width: number): void {
    if (width <= 0 || width === this.canvas.width) return;
    this.canvas.width = width;
    if (this.samples) {
      this.renderPeaks();
      this.drawCursor();
    } else {
      this.clearCanvas();
    }
  }

  destroy(): void {
    this.canvas.removeEventListener("pointerdown", this.onCanvasPointerDown);
    this.canvas.removeEventListener("pointermove", this.onCanvasPointerMove);
    this.canvas.removeEventListener("pointerup", this.onCanvasPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onCanvasPointerUp);
    this.playBtn.removeEventListener("click", this.onPlayClick);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    try {
      this.audioEl.pause();
    } catch {
      // ignored
    }
    if (this.audioEl.src && this.audioEl.src.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(this.audioEl.src);
      } catch {
        // ignored
      }
    }
    this.audioEl.removeAttribute("src");
    this.audioEl.remove();
  }

  // ── private ──────────────────────────────────────────────────────────────

  private renderInitial(): void {
    if (this.input.kind === "missing") {
      this.labelEl.textContent = t("audio.playerNoAudio" as StringKey);
      this.playBtn.disabled = true;
      this.setState("idle");
      return;
    }
    if (this.input.kind === "expired") {
      this.labelEl.textContent = t("audio.playerExpired" as StringKey);
      this.playBtn.disabled = true;
      this.setState("idle");
      return;
    }
    // kind === "audio": canvas placeholder + disabled play until load() runs.
    this.playBtn.disabled = true;
    this.timeEl.textContent = "0:00 / 0:00";
    this.setState("idle");
  }

  private setState(next: PlayerState): void {
    this._state = next;
    this.root.setAttribute("data-state", next);
    // Action attribute follows playback affordance.
    this.playBtn.dataset.action = next === "playing" ? "pause" : "play";
    this.playBtn.textContent = next === "playing" ? "❚❚" : "▶";
  }

  private handleDecodeError(err: unknown): void {
    this.labelEl.textContent = t("audio.playerError" as StringKey);
    this.playBtn.disabled = true;
    this.drawFlatBaseline();
    this.setState("error");
    this.onError(err);
  }

  private renderPeaks(): void {
    if (!this.samples) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const mid = h / 2;
    this.peaks = computePeaks(this.samples, w);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#7aa2f7";
    ctx.strokeStyle = "#7aa2f7";
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let x = 0; x < this.peaks.length; x++) {
      const [min, max] = this.peaks[x];
      // Float32 samples in [-1, 1] → pixel rows around mid.
      const yMin = mid - max * mid;
      const yMax = mid - min * mid;
      // Always paint at least one pixel column even for a flat line.
      const top = Math.min(yMin, yMax);
      const bot = Math.max(yMin, yMax);
      ctx.moveTo(x + 0.5, top);
      ctx.lineTo(x + 0.5, Math.max(bot, top + 1));
    }
    ctx.stroke();
  }

  private drawFlatBaseline(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const mid = Math.floor(h / 2);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(w, mid + 0.5);
    ctx.stroke();
  }

  private clearCanvas(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private drawCursor(): void {
    if (!this.samples) return;
    if (this.input.kind !== "audio") return;
    // Recompute peaks render then overlay the cursor.
    this.renderPeaks();
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const durSec = this.input.duration_ms / 1000;
    const cur = this.audioEl.currentTime;
    if (!Number.isFinite(cur) || durSec <= 0) return;
    const x = Math.min(w - 1, Math.max(0, (cur / durSec) * w));
    ctx.strokeStyle = "#f7768e";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }

  private async handlePlayClick(): Promise<void> {
    if (this.input.kind !== "audio") return;
    if (this._state === "ready" || this._state === "paused") {
      try {
        await this.audioEl.play();
      } catch (err) {
        this.handleDecodeError(err);
        return;
      }
      this.setState("playing");
      this.startTicker();
    } else if (this._state === "playing") {
      this.audioEl.pause();
      this.setState("paused");
      this.stopTicker();
    }
  }

  private canSeek(): boolean {
    if (this.input.kind !== "audio") return false;
    return (
      this._state === "ready" ||
      this._state === "playing" ||
      this._state === "paused"
    );
  }

  private seekToOffsetX(offsetX: number): void {
    if (this.input.kind !== "audio") return;
    const w = this.canvas.width;
    if (w <= 0) return;
    const x = Math.max(0, Math.min(w, offsetX));
    const durSec = this.input.duration_ms / 1000;
    this.audioEl.currentTime = (x / w) * durSec;
    this.drawCursor();
    this.updateTimeText();
  }

  private handleCanvasPointerDown(ev: PointerEvent): void {
    if (!this.canSeek()) return;
    // Capture so a fast drag that leaves the canvas still routes pointermove
    // back here. happy-dom may not implement this — guard so tests don't blow up.
    try {
      this.canvas.setPointerCapture?.(ev.pointerId);
    } catch {
      // ignored
    }
    this.isScrubbing = true;
    this.seekToOffsetX(ev.offsetX);
  }

  private handleCanvasPointerMove(ev: PointerEvent): void {
    if (!this.isScrubbing) return;
    if (!this.canSeek()) return;
    this.seekToOffsetX(ev.offsetX);
  }

  private handleCanvasPointerUp(ev: PointerEvent): void {
    if (!this.isScrubbing) return;
    this.isScrubbing = false;
    try {
      this.canvas.releasePointerCapture?.(ev.pointerId);
    } catch {
      // ignored
    }
  }

  private startTicker(): void {
    if (typeof requestAnimationFrame !== "function") return;
    const tick = (): void => {
      if (this._state !== "playing") return;
      this.updateTimeText();
      this.drawCursor();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopTicker(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private updateTimeText(): void {
    if (this.input.kind !== "audio") return;
    const cur = Math.floor(this.audioEl.currentTime * 1000);
    this.timeEl.textContent = `${formatMmSs(cur)} / ${formatMmSs(this.input.duration_ms)}`;
  }
}

function formatMmSs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

async function defaultDecode(blob: Blob): Promise<Float32Array> {
  // Real-browser path. Tests always inject `decode`.
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) {
    throw new Error("AudioContext is not available in this environment");
  }
  const ctx = new Ctor();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    // Mix down to mono by averaging channels (waveform peaks don't need stereo).
    const channels = decoded.numberOfChannels;
    const length = decoded.length;
    const out = new Float32Array(length);
    for (let ch = 0; ch < channels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        out[i] += data[i] / channels;
      }
    }
    return out;
  } finally {
    if (typeof ctx.close === "function") {
      void ctx.close();
    }
  }
}
