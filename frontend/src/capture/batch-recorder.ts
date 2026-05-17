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
 *   - Enforces a hard upper limit (`maxDurationMs`, default 10 min) so a
 *     forgotten session doesn't fill memory.
 *   - `stop()` returns the recorded Blob and its measured duration in ms.
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
  durationMs: number;
}

export class BatchRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.recorder.addEventListener("dataavailable", (e: BlobEvent) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    });
    this.recorder.addEventListener("stop", () => {
      const blob = new Blob(this.chunks, {
        type: this.resolvedMimeType || "audio/webm",
      });
      const durationMs = Math.max(0, Date.now() - this.startedAt);
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
    this.startedAt = Date.now();
    this.recorder.start();
    const maxMs = this.options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.autoStopTimer = setTimeout(() => {
      this.options.onAutoStop?.();
      // Fire and forget — caller will await stop() if it cares about the blob.
      void this.stop();
    }, maxMs);
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

  /** Current elapsed recording duration in milliseconds. */
  elapsedMs(): number {
    return this.recorder ? Math.max(0, Date.now() - this.startedAt) : 0;
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
