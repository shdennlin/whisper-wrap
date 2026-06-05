import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DualRecorder, PREFERRED_MIME_TYPES } from "./dual-recorder";

// MediaRecorder is not provided by happy-dom; install a minimal mock that
// exercises the start/pause/resume/dataavailable/stop event flow the
// implementation relies on. Mirrors the shim used in batch-recorder.test.ts
// but extends it with pause()/resume() support since DualRecorder needs it.

interface MockListenerMap {
  [event: string]: ((ev: Event) => void)[];
}

let lastRecorder: MockMediaRecorder | null = null;
let isTypeSupportedImpl: (mime: string) => boolean = (mime) =>
  mime.startsWith("audio/webm");

class MockMediaRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType: string;
  private listeners: MockListenerMap = {};

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    lastRecorder = this;
  }

  static isTypeSupported(mime: string): boolean {
    return isTypeSupportedImpl(mime);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.fire("dataavailable", {
      data: new Blob(["chunk"], { type: this.mimeType }),
      size: 5,
    });
    this.fire("stop", {});
  }

  pause(): void {
    if (this.state !== "recording") return;
    this.state = "paused";
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.state = "recording";
  }

  addEventListener(event: string, fn: (ev: Event) => void): void {
    (this.listeners[event] ||= []).push(fn);
  }

  removeEventListener(event: string, fn: (ev: Event) => void): void {
    this.listeners[event] = (this.listeners[event] || []).filter((x) => x !== fn);
  }

  private fire(event: string, payload: Record<string, unknown>): void {
    for (const fn of this.listeners[event] || []) fn(payload as unknown as Event);
  }
}

class MockMediaStreamTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class MockMediaStream {
  private tracks = [new MockMediaStreamTrack()];
  getTracks(): MockMediaStreamTrack[] {
    return this.tracks;
  }
}

function makeStream(): MediaStream {
  return new MockMediaStream() as unknown as MediaStream;
}

describe("DualRecorder", () => {
  let originalRecorder: unknown;

  beforeEach(() => {
    originalRecorder = (globalThis as Record<string, unknown>).MediaRecorder;
    (globalThis as Record<string, unknown>).MediaRecorder = MockMediaRecorder;
    isTypeSupportedImpl = (mime) =>
      mime === "audio/webm;codecs=opus" || mime === "audio/mp4";
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).MediaRecorder = originalRecorder;
    lastRecorder = null;
    vi.useRealTimers();
  });

  it("exports PREFERRED_MIME_TYPES with webm-opus before mp4", () => {
    expect(PREFERRED_MIME_TYPES).toEqual([
      "audio/webm;codecs=opus",
      "audio/mp4",
    ]);
  });

  it("selects audio/webm;codecs=opus when both webm-opus and mp4 are supported", () => {
    isTypeSupportedImpl = (mime) =>
      mime === "audio/webm;codecs=opus" || mime === "audio/mp4";
    const rec = new DualRecorder(makeStream(), "batch", true);
    rec.start();
    expect(lastRecorder).not.toBeNull();
    expect(lastRecorder!.mimeType).toBe("audio/webm;codecs=opus");
  });

  it("falls back to audio/mp4 when only mp4 is supported", () => {
    isTypeSupportedImpl = (mime) => mime === "audio/mp4";
    const rec = new DualRecorder(makeStream(), "batch", true);
    rec.start();
    expect(lastRecorder).not.toBeNull();
    expect(lastRecorder!.mimeType).toBe("audio/mp4");
  });

  it("batch mode with saveAudio=true resolves stop() with a non-null blob", async () => {
    const rec = new DualRecorder(makeStream(), "batch", true);
    rec.start();
    const result = await rec.stop();
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob!.size).toBeGreaterThan(0);
    expect(result.mime_type).toBe("audio/webm;codecs=opus");
    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("live mode with saveAudio=true resolves stop() with a non-null blob (same behaviour as batch)", async () => {
    const rec = new DualRecorder(makeStream(), "live", true);
    rec.start();
    const result = await rec.stop();
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob!.size).toBeGreaterThan(0);
    expect(result.mime_type).toBe("audio/webm;codecs=opus");
    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("saveAudio=false in live mode skips constructing MediaRecorder and resolves with nulls", async () => {
    const rec = new DualRecorder(makeStream(), "live", false);
    rec.start();
    expect(lastRecorder).toBeNull();
    rec.pause();
    rec.resume();
    const result = await rec.stop();
    expect(result.blob).toBeNull();
    expect(result.mime_type).toBeNull();
    expect(result.duration_ms).toBe(0);
    expect(lastRecorder).toBeNull();
  });

  it("saveAudio=false in batch mode skips constructing MediaRecorder and resolves with nulls", async () => {
    const rec = new DualRecorder(makeStream(), "batch", false);
    rec.start();
    expect(lastRecorder).toBeNull();
    const result = await rec.stop();
    expect(result.blob).toBeNull();
    expect(result.mime_type).toBeNull();
    expect(result.duration_ms).toBe(0);
  });

  it("pause excludes time from duration_ms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    const rec = new DualRecorder(makeStream(), "batch", true);
    rec.start();
    vi.advanceTimersByTime(1000); // 1000 ms active
    rec.pause();
    vi.advanceTimersByTime(5000); // 5000 ms paused — must NOT count
    rec.resume();
    vi.advanceTimersByTime(500); // 500 ms active
    const result = await rec.stop();
    expect(result.duration_ms).toBe(1500);
  });

  it("stop() is idempotent — second call returns the same promise without throwing", async () => {
    const rec = new DualRecorder(makeStream(), "batch", true);
    rec.start();
    const first = rec.stop();
    const second = rec.stop();
    expect(second).toBe(first);
    const r1 = await first;
    const r2 = await second;
    expect(r2).toEqual(r1);
  });
});
