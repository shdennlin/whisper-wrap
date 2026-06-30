/**
 * Tests for `createLiveWaveform` — the stream-fed live waveform drawn while
 * recording. See openspec/changes/fe-home-dashboard task 1.2.
 *
 * Test environment notes:
 *   - happy-dom ships neither AudioContext nor a real 2D canvas context.
 *     We stub AudioContext / requestAnimationFrame / cancelAnimationFrame /
 *     matchMedia via vi.stubGlobal, and patch getContext on the test canvas
 *     instance so draw paths execute and can be counted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLiveWaveform } from "./live-waveform";

interface Ctx2dStub {
  strokeStyle: string;
  lineWidth: number;
  calls: Array<{ method: string; args: unknown[] }>;
  clearRect: (...a: unknown[]) => void;
  beginPath: () => void;
  moveTo: (...a: unknown[]) => void;
  lineTo: (...a: unknown[]) => void;
  stroke: () => void;
}

function makeCtx2dStub(): Ctx2dStub {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const rec =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  return {
    strokeStyle: "",
    lineWidth: 1,
    calls,
    clearRect: rec("clearRect"),
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    stroke: rec("stroke"),
  };
}

/** Canvas whose getContext("2d") returns a recording stub. */
function makeCanvas(): { canvas: HTMLCanvasElement; ctx2d: Ctx2dStub } {
  const canvas = document.createElement("canvas");
  const ctx2d = makeCtx2dStub();
  Object.defineProperty(canvas, "getContext", {
    configurable: true,
    value: (type: string): Ctx2dStub | null => (type === "2d" ? ctx2d : null),
  });
  return { canvas, ctx2d };
}

class FakeAnalyser {
  fftSize = 0;
  frequencyBinCount = 1024;
  getByteTimeDomainData = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  analyser = new FakeAnalyser();
  source = { connect: vi.fn() };
  close = vi.fn((): Promise<void> => Promise.resolve());
  createAnalyser = vi.fn(() => this.analyser);
  createMediaStreamSource = vi.fn(() => this.source);
  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

const fakeStream = { id: "fake" } as unknown as MediaStream;

let rafSpy: ReturnType<typeof vi.fn>;
let cafSpy: ReturnType<typeof vi.fn>;
let rafCallbacks: FrameRequestCallback[];

beforeEach(() => {
  FakeAudioContext.instances = [];
  rafCallbacks = [];
  rafSpy = vi.fn((cb: FrameRequestCallback): number => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  cafSpy = vi.fn();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("requestAnimationFrame", rafSpy);
  vi.stubGlobal("cancelAnimationFrame", cafSpy);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createLiveWaveform", () => {
  it("start creates one AudioContext, wires source→analyser, schedules rAF", () => {
    const { canvas } = makeCanvas();
    const wf = createLiveWaveform(canvas);

    wf.start(fakeStream);

    expect(FakeAudioContext.instances).toHaveLength(1);
    const ac = FakeAudioContext.instances[0];
    expect(ac.createAnalyser).toHaveBeenCalledTimes(1);
    expect(ac.analyser.fftSize).toBe(2048);
    expect(ac.createMediaStreamSource).toHaveBeenCalledWith(fakeStream);
    expect(ac.source.connect).toHaveBeenCalledWith(ac.analyser);
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it("second start without stop creates no second context", () => {
    const { canvas } = makeCanvas();
    const wf = createLiveWaveform(canvas);

    wf.start(fakeStream);
    wf.start(fakeStream);

    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it("stop cancels the pending rAF id and closes the AudioContext", () => {
    const { canvas } = makeCanvas();
    const wf = createLiveWaveform(canvas);

    wf.start(fakeStream);
    wf.stop();

    expect(cafSpy).toHaveBeenCalledWith(1);
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("stop twice does not throw and closes only once", () => {
    const { canvas } = makeCanvas();
    const wf = createLiveWaveform(canvas);

    wf.start(fakeStream);
    wf.stop();
    expect(() => wf.stop()).not.toThrow();
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("stop before start does not throw", () => {
    const { canvas } = makeCanvas();
    const wf = createLiveWaveform(canvas);

    expect(() => wf.stop()).not.toThrow();
    expect(cafSpy).not.toHaveBeenCalled();
  });

  it("start works again after stop", () => {
    const { canvas } = makeCanvas();
    const wf = createLiveWaveform(canvas);

    wf.start(fakeStream);
    wf.stop();
    wf.start(fakeStream);

    expect(FakeAudioContext.instances).toHaveLength(2);
  });

  it("reduced motion: draws one static bar and schedules no rAF", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const { canvas, ctx2d } = makeCanvas();
    const wf = createLiveWaveform(canvas);

    wf.start(fakeStream);

    expect(rafSpy).not.toHaveBeenCalled();
    const strokes = ctx2d.calls.filter((c) => c.method === "stroke");
    expect(strokes).toHaveLength(1);
  });

  it("AudioContext constructor throwing: start does not throw, schedules nothing", () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("no audio hardware");
        }
      },
    );
    const { canvas } = makeCanvas();
    const wf = createLiveWaveform(canvas);

    expect(() => wf.start(fakeStream)).not.toThrow();
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it("createMediaStreamSource throwing: start does not throw, schedules nothing", () => {
    const { canvas } = makeCanvas();
    const wf = createLiveWaveform(canvas);
    const bad = {
      ...fakeStream,
    } as unknown as MediaStream;
    vi.stubGlobal(
      "AudioContext",
      class extends FakeAudioContext {
        override createMediaStreamSource = vi.fn(() => {
          throw new Error("not a real stream");
        });
      },
    );

    expect(() => wf.start(bad)).not.toThrow();
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it("getContext('2d') returning null is a safe no-op", () => {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "getContext", {
      configurable: true,
      value: (): null => null,
    });
    const wf = createLiveWaveform(canvas);

    expect(() => wf.start(fakeStream)).not.toThrow();
    expect(rafSpy).not.toHaveBeenCalled();
    expect(() => wf.stop()).not.toThrow();
  });
});
