import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchRecorder } from "./batch-recorder";

// MediaRecorder is not provided by happy-dom; install a minimal mock that
// exercises the start/dataavailable/stop event flow the implementation relies on.

interface MockListenerMap {
  [event: string]: ((ev: Event) => void)[];
}

let lastRecorder: MockMediaRecorder | null = null;

class MockMediaRecorder {
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  private listeners: MockListenerMap = {};

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    lastRecorder = this;
  }

  static isTypeSupported(mime: string): boolean {
    return mime.startsWith("audio/webm");
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.fire("dataavailable", { data: new Blob(["chunk"], { type: this.mimeType }), size: 5 });
    this.fire("stop", {});
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

describe("BatchRecorder", () => {
  let originalRecorder: unknown;
  let originalMediaDevices: unknown;
  let getUserMediaCalls: MediaStreamConstraints[];

  beforeEach(() => {
    originalRecorder = (globalThis as Record<string, unknown>).MediaRecorder;
    (globalThis as Record<string, unknown>).MediaRecorder = MockMediaRecorder;

    getUserMediaCalls = [];
    originalMediaDevices = (navigator as unknown as { mediaDevices: unknown }).mediaDevices;
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getUserMedia: async (c: MediaStreamConstraints) => {
        getUserMediaCalls.push(c);
        return new MockMediaStream() as unknown as MediaStream;
      },
    };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).MediaRecorder = originalRecorder;
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = originalMediaDevices;
    lastRecorder = null;
    vi.useRealTimers();
  });

  it("starts MediaRecorder with the first supported MIME type", async () => {
    const rec = new BatchRecorder();
    await rec.start();
    expect(lastRecorder).not.toBeNull();
    expect(lastRecorder!.mimeType).toBe("audio/webm;codecs=opus");
  });

  it("stop() resolves with the recorded blob, mimeType, and durationMs", async () => {
    vi.useFakeTimers();
    const rec = new BatchRecorder();
    await rec.start();
    vi.advanceTimersByTime(1500); // simulate 1.5 s of recording
    const result = await rec.stop();
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.mimeType).toMatch(/^audio\/webm/);
    expect(result.durationMs).toBe(1500);
  });

  it("auto-stops after maxDurationMs and invokes onAutoStop", async () => {
    vi.useFakeTimers();
    const onAutoStop = vi.fn();
    const rec = new BatchRecorder({ maxDurationMs: 1000, onAutoStop });
    await rec.start();
    vi.advanceTimersByTime(1000);
    expect(onAutoStop).toHaveBeenCalledOnce();
  });

  it("rejects starting twice", async () => {
    const rec = new BatchRecorder();
    await rec.start();
    await expect(rec.start()).rejects.toThrow(/already started/);
  });

  it("forwards deviceId in the getUserMedia constraints", async () => {
    const rec = new BatchRecorder({ deviceId: "mic-3" });
    await rec.start();
    const audio = getUserMediaCalls[0]?.audio as
      | { deviceId?: { exact: string } }
      | undefined;
    expect(audio?.deviceId).toEqual({ exact: "mic-3" });
  });
});
