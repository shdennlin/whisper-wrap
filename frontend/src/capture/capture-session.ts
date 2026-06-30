/**
 * Capture session (fe-recording-modes): one session that owns the microphone
 * (PCM frames via MicPipeline) and the compressed-blob recorder (DualRecorder)
 * over a single MediaStream — independently of any transcription strategy.
 *
 * "Live" is no longer a mode chosen up front; it is a `LiveCaptionSink`
 * attached to the frame stream at any point during recording. The session
 * forwards frames to an attached sink and stops forwarding when it is detached,
 * never restarting capture. Capture never depends on the sink, so a sink
 * failure leaves the recording intact.
 *
 * States: idle → recording ⇄ paused → stopped.
 */

import { MicPipeline } from "./mic-pipeline";
import { DualRecorder } from "./dual-recorder";
import type { LiveCaptionSink } from "./live-caption-strategy";

export type CaptureState = "idle" | "recording" | "paused" | "stopped";

export interface CaptureResult {
  blob: Blob | null;
  durationMs: number;
}

/**
 * A full batch re-transcription re-runs Whisper over the whole recording, which
 * takes noticeable time/CPU on longer clips. Past this duration the opt-in
 * "re-transcribe (higher quality)" action warns before running. ~2 minutes is
 * where a local Whisper pass starts to feel slow.
 */
export const RE_TRANSCRIBE_WARN_MS = 120_000;

/** Whether the opt-in re-transcribe action should warn about time/cost first. */
export function shouldWarnReTranscribe(
  durationMs: number,
  thresholdMs: number = RE_TRANSCRIBE_WARN_MS,
): boolean {
  return durationMs > thresholdMs;
}

/** Minimal mic surface the session depends on (real: MicPipeline). */
interface MicLike {
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  getStream(): MediaStream | null;
  stop(): Promise<void>;
}

/** Minimal recorder surface the session depends on (real: DualRecorder). */
interface RecorderLike {
  start(): void;
  pause(): void;
  resume(): void;
  stop(): Promise<{ blob: Blob | null; duration_ms: number }>;
}

export interface CaptureSessionOptions {
  deviceId?: string;
  /** Persist the compressed blob (passed through to DualRecorder). */
  saveAudio: boolean;
  /** Injectable mic factory (tests); defaults to MicPipeline. */
  createMic?: (opts: {
    deviceId?: string;
    onFrame: (f: ArrayBuffer) => void;
  }) => MicLike;
  /** Injectable recorder factory (tests); defaults to DualRecorder. */
  createRecorder?: (stream: MediaStream, saveAudio: boolean) => RecorderLike;
}

export class CaptureSession {
  private mic: MicLike | null = null;
  private recorder: RecorderLike | null = null;
  private sink: LiveCaptionSink | null = null;
  private _state: CaptureState = "idle";

  constructor(private readonly opts: CaptureSessionOptions) {}

  get state(): CaptureState {
    return this._state;
  }

  /** The live MediaStream once started (for the recbar waveform), else null. */
  getStream(): MediaStream | null {
    return this.mic?.getStream() ?? null;
  }

  /** Begin capturing immediately; no transcription decision is made here. */
  async start(): Promise<void> {
    if (this._state !== "idle") {
      throw new Error(`CaptureSession.start() invalid from ${this._state}`);
    }
    const createMic =
      this.opts.createMic ?? ((o) => new MicPipeline(o));
    this.mic = createMic({
      deviceId: this.opts.deviceId,
      onFrame: (f) => this.onFrame(f),
    });
    await this.mic.start();

    const stream = this.mic.getStream();
    const createRecorder =
      this.opts.createRecorder ??
      ((s, save) => new DualRecorder(s, "batch", save));
    // The mic owns the stream; DualRecorder taps it for the compressed blob.
    this.recorder = createRecorder(stream as MediaStream, this.opts.saveAudio);
    this.recorder.start();
    this._state = "recording";
  }

  private onFrame(frame: ArrayBuffer): void {
    // Forward only while actively recording and a sink is attached. A paused
    // session or a detached sink drops frames at this edge.
    if (this._state === "recording" && this.sink) this.sink.pushFrame(frame);
  }

  pause(): void {
    if (this._state !== "recording") return;
    this.mic?.pause();
    this.recorder?.pause();
    this._state = "paused";
  }

  resume(): void {
    if (this._state !== "paused") return;
    this.mic?.resume();
    this.recorder?.resume();
    this._state = "recording";
  }

  /**
   * Attach a live caption sink mid-recording. No-op outside recording/paused.
   * Replaces (and closes) any existing sink. Frames are forwarded from this
   * point on — earlier audio is never replayed (no backfill). If the sink
   * fails to open, it is dropped and capture continues unaffected.
   */
  attachLiveSink(sink: LiveCaptionSink): void {
    if (this._state !== "recording" && this._state !== "paused") return;
    if (this.sink) void this.sink.close();
    this.sink = sink;
    void sink.open().catch(() => {
      // Capture never depends on the sink: drop it so we don't forward into a
      // dead consumer, and leave the recording running.
      if (this.sink === sink) this.sink = null;
    });
  }

  /** Detach the live sink; recording continues. Already-shown partials stand. */
  detachLiveSink(): void {
    if (!this.sink) return;
    const s = this.sink;
    this.sink = null;
    void s.close();
  }

  /** Stop capture; resolves the recorded blob + duration (even with no sink). */
  async stop(): Promise<CaptureResult> {
    if (this._state === "idle" || this._state === "stopped") {
      return { blob: null, durationMs: 0 };
    }
    if (this.sink) {
      const s = this.sink;
      this.sink = null;
      void s.close();
    }
    const rec = this.recorder ? await this.recorder.stop() : null;
    await this.mic?.stop();
    this.mic = null;
    this.recorder = null;
    this._state = "stopped";
    return { blob: rec?.blob ?? null, durationMs: rec?.duration_ms ?? 0 };
  }
}
