/**
 * Microphone-to-Blob recorder backed by `MediaRecorder`.
 *
 * Used by the Batch mode capture pipeline: record the full utterance locally,
 * then POST the Blob to `/transcribe`. The host caller is responsible for
 * uploading and rendering the response.
 *
 * Behaviour:
 *   - Picks the first supported MIME from a short preference list (audio/webm,
 *     audio/mp4) so Safari (no webm) and Chromium (no mp4) both work.
 *   - Enforces a hard upper limit (`maxDurationMs`, default 10 min) on active
 *     recording time so a forgotten session doesn't fill memory.
 *   - Supports pause()/resume() (MediaRecorder native); paused time does NOT
 *     count toward the upper limit.
 *   - discard() drops the captured buffer without resolving stop().
 *   - `stop()` returns the recorded Blob and its measured *active* duration.
 */

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

export const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000;

export interface BatchRecorderOptions {
  deviceId?: string;
  /** Fires when the hard upper limit elapses; stop() has already been called. */
  onAutoStop?: () => void;
  maxDurationMs?: number;
}

export interface BatchRecording {
  blob: Blob;
  mimeType: string;
  /** Active recording time in milliseconds, excluding any paused intervals. */
  durationMs: number;
}

export class BatchRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  /** Wall-clock when the current active run began (start or resume). */
  private runStartedAt = 0;
  /** Cumulative active time from previous run segments (sum across pauses). */
  private accumulatedActiveMs = 0;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  private maxMs = DEFAULT_MAX_DURATION_MS;
  private resolvedMimeType = "";
  private stopPromise: Promise<BatchRecording> | null = null;
  private resolveStop: ((r: BatchRecording) => void) | null = null;
  private rejectStop: ((e: Error) => void) | null = null;

  constructor(private readonly options: BatchRecorderOptions = {}) {}

  async start(): Promise<void> {
    if (this.recorder) {
      throw new Error("BatchRecorder already started");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.options.deviceId
          ? { exact: this.options.deviceId }
          : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
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
      const blob = new Blob(this.chunks, {
        type: this.resolvedMimeType || "audio/webm",
      });
      const durationMs = this.snapshotActiveMs();
      this.cleanup();
      this.resolveStop?.({ blob, mimeType: blob.type, durationMs });
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
    this.maxMs = this.options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.scheduleAutoStop(this.maxMs);
  }

  /** The live capture MediaStream (for a waveform), or null before start(). */
  getStream(): MediaStream | null {
    return this.stream;
  }

  async stop(): Promise<BatchRecording> {
    if (!this.recorder) {
      throw new Error("BatchRecorder not started");
    }
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = new Promise<BatchRecording>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    if (this.recorder.state !== "inactive") {
      this.recorder.stop();
    }
    return this.stopPromise;
  }

  /** Pause recording. Paused intervals do not count toward duration. Idempotent. */
  pause(): void {
    if (!this.recorder || this.recorder.state !== "recording") return;
    this.recorder.pause();
    this.accumulatedActiveMs += Date.now() - this.runStartedAt;
    if (this.autoStopTimer !== null) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
  }

  /** Resume recording from pause. Idempotent. */
  resume(): void {
    if (!this.recorder || this.recorder.state !== "paused") return;
    this.recorder.resume();
    this.runStartedAt = Date.now();
    const remaining = Math.max(0, this.maxMs - this.accumulatedActiveMs);
    this.scheduleAutoStop(remaining);
  }

  /** True when the recorder exists and is currently paused. */
  isPaused(): boolean {
    return this.recorder?.state === "paused";
  }

  /**
   * Discard the recording: stop the recorder, drop the captured blob, and
   * resolve the stop promise (if any) with an empty blob. Used by the UI
   * "discard" button so callers can detect a 0-byte result and skip uploads.
   */
  async discard(): Promise<void> {
    if (!this.recorder) return;
    this.chunks = [];
    const wasInactive = this.recorder.state === "inactive";
    try {
      if (!wasInactive) this.recorder.stop();
    } catch {
      // Safari has thrown when stopping a paused recorder; cleanup still runs.
    }
    this.cleanup();
    const mime = this.resolvedMimeType || "audio/webm";
    this.resolveStop?.({
      blob: new Blob([], { type: mime }),
      mimeType: mime,
      durationMs: 0,
    });
    this.resolveStop = null;
    this.rejectStop = null;
    this.stopPromise = null;
  }

  /** Current elapsed *active* recording duration, excluding paused intervals. */
  elapsedMs(): number {
    return this.snapshotActiveMs();
  }

  private snapshotActiveMs(): number {
    if (!this.recorder) return this.accumulatedActiveMs;
    if (this.recorder.state === "paused") return this.accumulatedActiveMs;
    return this.accumulatedActiveMs + Math.max(0, Date.now() - this.runStartedAt);
  }

  private scheduleAutoStop(remainingMs: number): void {
    if (this.autoStopTimer !== null) clearTimeout(this.autoStopTimer);
    this.autoStopTimer = setTimeout(() => {
      this.options.onAutoStop?.();
      void this.stop();
    }, remainingMs);
  }

  private cleanup(): void {
    if (this.autoStopTimer !== null) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.recorder = null;
  }
}

function pickSupportedMime(): string {
  const Cls = (globalThis as { MediaRecorder?: { isTypeSupported?: (m: string) => boolean } })
    .MediaRecorder;
  const check = Cls?.isTypeSupported;
  if (typeof check !== "function") return "";
  for (const mime of PREFERRED_MIME_TYPES) {
    if (check.call(Cls, mime)) return mime;
  }
  return "";
}
