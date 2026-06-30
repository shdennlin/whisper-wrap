import { describe, expect, it, vi } from "vitest";

import {
  CaptureSession,
  RE_TRANSCRIBE_WARN_MS,
  shouldWarnReTranscribe,
} from "./capture-session";
import type { LiveCaptionSink } from "./live-caption-strategy";

const tick = () => new Promise((r) => setTimeout(r, 0));
const buf = (n: number) => new Uint8Array([n]).buffer;

class FakeMic {
  onFrame: (f: ArrayBuffer) => void;
  paused = false;
  started = false;
  stopped = false;
  private stream = {} as MediaStream;
  constructor(opts: { deviceId?: string; onFrame: (f: ArrayBuffer) => void }) {
    this.onFrame = opts.onFrame;
  }
  async start(): Promise<void> {
    this.started = true;
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  getStream(): MediaStream | null {
    return this.stream;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  /** Test helper: deliver a frame the way the worklet would. */
  emit(f: ArrayBuffer): void {
    this.onFrame(f);
  }
}

class FakeRecorder {
  started = false;
  paused = false;
  stopped = false;
  constructor(
    public stream: MediaStream,
    public saveAudio: boolean,
  ) {}
  start(): void {
    this.started = true;
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  stop(): Promise<{ blob: Blob | null; mime_type: string | null; duration_ms: number }> {
    this.stopped = true;
    return Promise.resolve({
      blob: new Blob(["x"], { type: "audio/webm" }),
      mime_type: "audio/webm",
      duration_ms: 1234,
    });
  }
}

function makeSink(overrides: Partial<LiveCaptionSink> = {}): LiveCaptionSink & {
  frames: ArrayBuffer[];
} {
  const frames: ArrayBuffer[] = [];
  return {
    frames,
    open: vi.fn(() => Promise.resolve()),
    pushFrame: vi.fn((f: ArrayBuffer) => frames.push(f)),
    close: vi.fn(() => Promise.resolve()),
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    state: "idle",
    ...overrides,
  } as LiveCaptionSink & { frames: ArrayBuffer[] };
}

function makeSession(): { session: CaptureSession; mic: () => FakeMic } {
  let mic!: FakeMic;
  const session = new CaptureSession({
    saveAudio: true,
    createMic: (o) => {
      mic = new FakeMic(o);
      return mic;
    },
    createRecorder: (s, save) => new FakeRecorder(s, save),
  });
  return { session, mic: () => mic };
}

describe("CaptureSession", () => {
  it("forwards frames to an attached sink and stops after detach", async () => {
    const { session, mic } = makeSession();
    await session.start();
    expect(session.state).toBe("recording");

    const sink = makeSink();
    session.attachLiveSink(sink);
    await tick();
    expect(sink.open).toHaveBeenCalledTimes(1);

    mic().emit(buf(1));
    mic().emit(buf(2));
    expect(sink.pushFrame).toHaveBeenCalledTimes(2);

    session.detachLiveSink();
    expect(sink.close).toHaveBeenCalledTimes(1);
    mic().emit(buf(3));
    expect(sink.pushFrame).toHaveBeenCalledTimes(2); // no further forwarding
  });

  it("stop resolves with the blob + duration when no sink was ever attached", async () => {
    const { session } = makeSession();
    await session.start();
    const r = await session.stop();
    expect(r.blob).toBeInstanceOf(Blob);
    expect(r.durationMs).toBe(1234);
    expect(session.state).toBe("stopped");
  });

  it("keeps recording when a sink's open() rejects", async () => {
    const { session, mic } = makeSession();
    await session.start();
    const sink = makeSink({ open: vi.fn(() => Promise.reject(new Error("ws fail"))) });
    session.attachLiveSink(sink);
    await tick();
    // Capture is unaffected by the dead sink.
    expect(session.state).toBe("recording");
    // The failed sink is dropped, so frames are not forwarded into it.
    mic().emit(buf(1));
    expect(sink.pushFrame).not.toHaveBeenCalled();
    const r = await session.stop();
    expect(r.durationMs).toBe(1234);
  });

  it("is a no-op to attach while idle or stopped", async () => {
    const { session } = makeSession();
    const idleSink = makeSink();
    session.attachLiveSink(idleSink); // idle
    expect(idleSink.open).not.toHaveBeenCalled();

    await session.start();
    await session.stop();
    const stoppedSink = makeSink();
    session.attachLiveSink(stoppedSink); // stopped
    expect(stoppedSink.open).not.toHaveBeenCalled();
  });

  it("shouldWarnReTranscribe warns only past the duration threshold", () => {
    expect(shouldWarnReTranscribe(0)).toBe(false);
    expect(shouldWarnReTranscribe(RE_TRANSCRIBE_WARN_MS)).toBe(false);
    expect(shouldWarnReTranscribe(RE_TRANSCRIBE_WARN_MS + 1)).toBe(true);
    // Custom threshold override.
    expect(shouldWarnReTranscribe(5_000, 4_000)).toBe(true);
    expect(shouldWarnReTranscribe(3_000, 4_000)).toBe(false);
  });

  it("pause/resume gates forwarding and pauses the recorder", async () => {
    const { session, mic } = makeSession();
    await session.start();
    const sink = makeSink();
    session.attachLiveSink(sink);
    await tick();

    session.pause();
    expect(session.state).toBe("paused");
    mic().emit(buf(1));
    expect(sink.pushFrame).not.toHaveBeenCalled();

    session.resume();
    expect(session.state).toBe("recording");
    mic().emit(buf(2));
    expect(sink.pushFrame).toHaveBeenCalledTimes(1);
  });
});
