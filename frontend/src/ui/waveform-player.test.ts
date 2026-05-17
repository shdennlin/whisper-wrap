/**
 * Tests for `WaveformPlayer` — the canvas-based replay component used in
 * history cards. See openspec/changes/audio-replay-and-re-asr/design.md
 * "Implementation Contract" for the full behaviour spec.
 *
 * Test environment notes:
 *   - happy-dom provides Canvas + <audio> elements but not AudioContext.
 *     We always inject the `decode` option to bypass real decoding.
 *   - happy-dom's <audio> does not actually play; we stub
 *     HTMLAudioElement.prototype.play / .pause and track currentTime mutations.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { WaveformPlayer } from "./waveform-player";

function mountRoot(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

/**
 * happy-dom's HTMLCanvasElement returns `null` from getContext("2d") — it
 * doesn't ship a full 2D context. We patch the prototype to return a minimal
 * stub that records calls, so the player's draw paths still execute and we
 * can assert that drawing happened.
 */
interface CanvasStub {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  calls: Array<{ method: string; args: unknown[] }>;
  clearRect: (...a: unknown[]) => void;
  beginPath: () => void;
  moveTo: (...a: unknown[]) => void;
  lineTo: (...a: unknown[]) => void;
  stroke: () => void;
  fillRect: (...a: unknown[]) => void;
}

function installCanvasStub(): void {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value(this: HTMLCanvasElement, type: string): CanvasStub | null {
      if (type !== "2d") return null;
      let stub = (this as unknown as { __ctx?: CanvasStub }).__ctx;
      if (!stub) {
        stub = makeCanvasStub();
        (this as unknown as { __ctx?: CanvasStub }).__ctx = stub;
      }
      return stub;
    },
  });
}

function makeCanvasStub(): CanvasStub {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const rec =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  return {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    calls,
    clearRect: rec("clearRect"),
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    stroke: rec("stroke"),
    fillRect: rec("fillRect"),
  };
}

function makeBlob(): Blob {
  // Real bytes don't matter — `decode` is always injected in tests.
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });
}

function flatSamples(n = 4096): Float32Array {
  // A simple ramp so computePeaks produces non-zero min/max → the canvas
  // draw renders visible pixels (used by the "non-blank ImageData" assertion).
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = ((i % 64) - 32) / 32; // triangle in [-1, 1]
  }
  return samples;
}

describe("WaveformPlayer", () => {
  let playSpy: ReturnType<typeof vi.spyOn>;
  let pauseSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installCanvasStub();
    // happy-dom's <audio> rejects play(); stub to a resolving spy.
    playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(function (this: HTMLMediaElement) {
        // Fire a synthetic 'play' event so listeners (if any) see it; even
        // without listeners this matches real browser semantics.
        this.dispatchEvent(new Event("play"));
        return Promise.resolve();
      });
    pauseSpy = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event("pause"));
      });
  });

  afterEach(() => {
    playSpy.mockRestore();
    pauseSpy.mockRestore();
    document.body.replaceChildren();
  });

  it("kind: missing renders idle disabled state with a label", () => {
    const root = mountRoot();
    const player = new WaveformPlayer({
      root,
      input: { kind: "missing" },
    });

    expect(player.state()).toBe("idle");
    expect(root.classList.contains("waveform-player")).toBe(true);
    expect(root.getAttribute("data-state")).toBe("idle");

    const btn = root.querySelector<HTMLButtonElement>(".waveform-play");
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);

    const label = root.querySelector(".waveform-label");
    expect(label).not.toBeNull();
    // Label text is i18n-key driven (key resolves to itself until 3.3 lands);
    // we only assert presence + that it's non-empty.
    expect((label!.textContent ?? "").length).toBeGreaterThan(0);

    player.destroy();
  });

  it("kind: expired renders idle disabled state with a label", () => {
    const root = mountRoot();
    const player = new WaveformPlayer({
      root,
      input: { kind: "expired" },
    });

    expect(player.state()).toBe("idle");
    expect(root.getAttribute("data-state")).toBe("idle");

    const btn = root.querySelector<HTMLButtonElement>(".waveform-play");
    expect(btn!.disabled).toBe(true);

    const label = root.querySelector(".waveform-label");
    expect(label).not.toBeNull();
    expect((label!.textContent ?? "").length).toBeGreaterThan(0);

    player.destroy();
  });

  it("kind: audio initial state is idle until load() runs", () => {
    const root = mountRoot();
    const decode = vi.fn(async () => flatSamples());
    const player = new WaveformPlayer({
      root,
      input: {
        kind: "audio",
        blob: makeBlob(),
        mime_type: "audio/webm",
        duration_ms: 1000,
      },
      decode,
    });

    expect(player.state()).toBe("idle");
    expect(decode).not.toHaveBeenCalled();

    const btn = root.querySelector<HTMLButtonElement>(".waveform-play");
    expect(btn!.disabled).toBe(true);

    const canvas = root.querySelector<HTMLCanvasElement>(".waveform-canvas");
    expect(canvas).not.toBeNull();

    const time = root.querySelector(".waveform-time");
    expect(time).not.toBeNull();
    expect(time!.textContent).toBe("0:00 / 0:00");

    player.destroy();
  });

  it("load() transitions through loading → ready and enables play", async () => {
    const root = mountRoot();

    // Make decode a manually-resolved promise so we can observe "loading".
    let resolveDecode!: (samples: Float32Array) => void;
    const decode = vi.fn(
      () =>
        new Promise<Float32Array>((resolve) => {
          resolveDecode = resolve;
        }),
    );

    const player = new WaveformPlayer({
      root,
      input: {
        kind: "audio",
        blob: makeBlob(),
        mime_type: "audio/webm",
        duration_ms: 83_000, // expect "1:23"
      },
      decode,
    });

    const loadPromise = player.load();
    expect(player.state()).toBe("loading");
    expect(root.getAttribute("data-state")).toBe("loading");

    resolveDecode(flatSamples());
    await loadPromise;

    expect(player.state()).toBe("ready");
    expect(root.getAttribute("data-state")).toBe("ready");

    const btn = root.querySelector<HTMLButtonElement>(".waveform-play");
    expect(btn!.disabled).toBe(false);

    const time = root.querySelector(".waveform-time");
    expect(time!.textContent).toBe("0:00 / 1:23");

    // Canvas should have been drawn (non-blank). happy-dom does not
    // implement a real 2D context, so we assert via our stub's recorded
    // calls that the player actually emitted draw commands.
    const canvas = root.querySelector<HTMLCanvasElement>(".waveform-canvas")!;
    const ctx = canvas.getContext("2d") as unknown as {
      calls: Array<{ method: string }>;
    };
    const lineToCount = ctx.calls.filter((c) => c.method === "lineTo").length;
    const strokeCount = ctx.calls.filter((c) => c.method === "stroke").length;
    expect(lineToCount).toBeGreaterThan(0);
    expect(strokeCount).toBeGreaterThan(0);

    player.destroy();
  });

  it("decode rejection transitions to error and calls onError once", async () => {
    const root = mountRoot();
    const reason = new Error("bad-codec");
    const decode = vi.fn(() => Promise.reject(reason));
    const onError = vi.fn();

    const player = new WaveformPlayer({
      root,
      input: {
        kind: "audio",
        blob: makeBlob(),
        mime_type: "audio/webm",
        duration_ms: 1000,
      },
      decode,
      onError,
    });

    await player.load();

    expect(player.state()).toBe("error");
    expect(root.getAttribute("data-state")).toBe("error");

    const btn = root.querySelector<HTMLButtonElement>(".waveform-play");
    expect(btn!.disabled).toBe(true);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(reason);

    player.destroy();
  });

  it("play button toggles between playing and paused", async () => {
    const root = mountRoot();
    const decode = vi.fn(async () => flatSamples());
    const player = new WaveformPlayer({
      root,
      input: {
        kind: "audio",
        blob: makeBlob(),
        mime_type: "audio/webm",
        duration_ms: 1000,
      },
      decode,
    });

    await player.load();
    expect(player.state()).toBe("ready");

    const btn = root.querySelector<HTMLButtonElement>(".waveform-play")!;

    btn.click();
    // play() resolves in the next microtask — wait for it.
    await Promise.resolve();
    await Promise.resolve();

    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(player.state()).toBe("playing");
    expect(root.getAttribute("data-state")).toBe("playing");
    expect(btn.getAttribute("data-action")).toBe("pause");

    btn.click();
    await Promise.resolve();

    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(player.state()).toBe("paused");
    expect(root.getAttribute("data-state")).toBe("paused");
    expect(btn.getAttribute("data-action")).toBe("play");

    player.destroy();
  });

  it("click on canvas seeks proportionally to click x", async () => {
    const root = mountRoot();
    const decode = vi.fn(async () => flatSamples());
    const player = new WaveformPlayer({
      root,
      input: {
        kind: "audio",
        blob: makeBlob(),
        mime_type: "audio/webm",
        duration_ms: 1000, // 1.0 second
      },
      decode,
    });

    await player.load();

    const canvas = root.querySelector<HTMLCanvasElement>(".waveform-canvas")!;
    const audio = root.querySelector<HTMLAudioElement>("audio")!;
    expect(audio).not.toBeNull();

    const width = canvas.width;
    expect(width).toBeGreaterThan(0);

    // Track currentTime mutations via a setter spy on the instance.
    let lastSet = audio.currentTime;
    Object.defineProperty(audio, "currentTime", {
      configurable: true,
      get: () => lastSet,
      set: (v: number) => {
        lastSet = v;
      },
    });

    // Build a click event with offsetX = width / 4 — happy-dom doesn't
    // compute offsetX from clientX, so we set it directly on the event.
    const ev = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(ev, "offsetX", { value: width / 4 });
    canvas.dispatchEvent(ev);

    // (width / 4) / width = 0.25; duration_ms / 1000 = 1.0 → 0.25 s.
    expect(audio.currentTime).toBeCloseTo(0.25, 5);

    player.destroy();
  });

  it("click on canvas while in error state is a no-op", async () => {
    const root = mountRoot();
    const decode = vi.fn(() => Promise.reject(new Error("bad")));
    const player = new WaveformPlayer({
      root,
      input: {
        kind: "audio",
        blob: makeBlob(),
        mime_type: "audio/webm",
        duration_ms: 1000,
      },
      decode,
      onError: () => {},
    });

    await player.load();
    expect(player.state()).toBe("error");

    const canvas = root.querySelector<HTMLCanvasElement>(".waveform-canvas")!;
    const audio = root.querySelector<HTMLAudioElement>("audio")!;

    const before = audio.currentTime;
    let lastSet = before;
    Object.defineProperty(audio, "currentTime", {
      configurable: true,
      get: () => lastSet,
      set: (v: number) => {
        lastSet = v;
      },
    });

    const ev = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(ev, "offsetX", { value: canvas.width / 4 });
    canvas.dispatchEvent(ev);

    expect(audio.currentTime).toBe(before);
    expect(player.state()).toBe("error");

    player.destroy();
  });
});
