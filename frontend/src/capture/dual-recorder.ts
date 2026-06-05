/**
 * Mode-agnostic compressed-blob recorder used by both Batch and Live capture
 * pipelines.
 *
 * Wraps a single `MediaRecorder` over a caller-supplied `MediaStream` and
 * produces an Opus/AAC blob on stop(). In Live mode the caller is also
 * responsible for the separate PCM tap (in `mic-pipeline.ts`); this class
 * only handles the compressed-blob side, so the `mode` parameter is purely
 * documentary today and exists for clarity at the call site.
 *
 * Differences vs `BatchRecorder`:
 *   - Does NOT call `getUserMedia` — the caller passes in a stream that may
 *     already be feeding the PCM worklet.
 *   - Honours a `saveAudio` flag: when false the internal `MediaRecorder` is
 *     never constructed (no CPU cost, no audio bytes captured) and `stop()`
 *     resolves with nulls so callers can skip persistence uniformly.
 *   - No auto-stop timer, no discard(): the host owns lifecycle.
 *
 * MIME picking: probes `MediaRecorder.isTypeSupported` in the order exported
 * as `PREFERRED_MIME_TYPES` and uses the first hit. Tests rely on this list
 * being inspectable.
 */

export const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4"];

export type DualRecorderMode = "batch" | "live";

export interface DualRecording {
  /** Concatenated compressed blob, or null when `saveAudio` was false. */
  blob: Blob | null;
  /** Chosen MIME, or null when `saveAudio` was false. */
  mime_type: string | null;
  /** Active recording time in milliseconds, excluding any paused intervals. */
  duration_ms: number;
}

export class DualRecorder {
  private readonly stream: MediaStream;
  private readonly mode: DualRecorderMode;
  private readonly saveAudio: boolean;

  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private resolvedMimeType = "";

  /** Wall-clock when the current active run began (start or resume). */
  private runStartedAt = 0;
  /** Cumulative active time from previous run segments (sum across pauses). */
  private accumulatedActiveMs = 0;

  private stopPromise: Promise<DualRecording> | null = null;
  private resolveStop: ((r: DualRecording) => void) | null = null;
  private rejectStop: ((e: Error) => void) | null = null;
  private started = false;
  private stopRequested = false;

  constructor(stream: MediaStream, mode: DualRecorderMode, saveAudio: boolean) {
    this.stream = stream;
    this.mode = mode;
    this.saveAudio = saveAudio;
    // `mode` is currently advisory; reference it to keep linters quiet and to
    // document the intent at the call site.
    void this.mode;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.saveAudio) return;

    this.resolvedMimeType = pickSupportedMime();
    this.recorder = new MediaRecorder(
      this.stream,
      this.resolvedMimeType ? { mimeType: this.resolvedMimeType } : undefined,
    );
    this.chunks = [];
    this.accumulatedActiveMs = 0;
    this.recorder.addEventListener("dataavailable", (e: BlobEvent) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    });
    this.recorder.addEventListener("stop", () => {
      const mime = this.resolvedMimeType || "audio/webm";
      const blob = new Blob(this.chunks, { type: mime });
      const duration_ms = this.snapshotActiveMs();
      this.cleanup();
      this.resolveStop?.({ blob, mime_type: mime, duration_ms });
      this.resolveStop = null;
      this.rejectStop = null;
    });
    this.recorder.addEventListener("error", (e: Event) => {
      const message =
        (e as ErrorEvent).message || "MediaRecorder reported an error";
      this.cleanup();
      this.rejectStop?.(new Error(message));
      this.resolveStop = null;
      this.rejectStop = null;
    });
    this.runStartedAt = Date.now();
    this.recorder.start();
  }

  pause(): void {
    if (!this.recorder || this.recorder.state !== "recording") return;
    this.recorder.pause();
    this.accumulatedActiveMs += Date.now() - this.runStartedAt;
  }

  resume(): void {
    if (!this.recorder || this.recorder.state !== "paused") return;
    this.recorder.resume();
    this.runStartedAt = Date.now();
  }

  stop(): Promise<DualRecording> {
    if (this.stopPromise) return this.stopPromise;

    if (!this.saveAudio) {
      this.stopPromise = Promise.resolve({
        blob: null,
        mime_type: null,
        duration_ms: 0,
      });
      return this.stopPromise;
    }

    this.stopRequested = true;
    this.stopPromise = new Promise<DualRecording>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
    } else if (!this.recorder) {
      // Defensive: saveAudio true but start() was never called.
      this.resolveStop?.({
        blob: new Blob([], { type: "audio/webm" }),
        mime_type: "audio/webm",
        duration_ms: 0,
      });
      this.resolveStop = null;
      this.rejectStop = null;
    }
    return this.stopPromise;
  }

  private snapshotActiveMs(): number {
    if (!this.recorder) return this.accumulatedActiveMs;
    if (this.recorder.state === "paused") return this.accumulatedActiveMs;
    if (this.runStartedAt === 0) return this.accumulatedActiveMs;
    return (
      this.accumulatedActiveMs + Math.max(0, Date.now() - this.runStartedAt)
    );
  }

  private cleanup(): void {
    this.recorder = null;
    // Note: the stream lifecycle is owned by the caller (it may still be
    // feeding the PCM worklet in Live mode) — do NOT stop tracks here.
    void this.stopRequested;
  }
}

function pickSupportedMime(): string {
  const Cls = (
    globalThis as {
      MediaRecorder?: { isTypeSupported?: (m: string) => boolean };
    }
  ).MediaRecorder;
  const check = Cls?.isTypeSupported;
  if (typeof check !== "function") return "";
  for (const mime of PREFERRED_MIME_TYPES) {
    if (check.call(Cls, mime)) return mime;
  }
  return "";
}
