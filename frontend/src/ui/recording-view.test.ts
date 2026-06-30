import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRecordingLayer,
  type RecordingLayer,
  type RecordingLayerDeps,
} from "./recording-view";

function makeDeps() {
  return {
    live: {
      onStart: vi.fn(),
      onStop: vi.fn(),
      onPauseResume: vi.fn(),
      onDiscard: vi.fn(),
    },
    batch: {
      onStart: vi.fn(),
      onStop: vi.fn(),
      onPauseResume: vi.fn(),
      onDiscard: vi.fn(),
      onFilePicked: vi.fn(),
      onConfirmStart: vi.fn(),
      onConfirmChange: vi.fn(),
    },
    setEntriesDisabled: vi.fn(),
  } satisfies RecordingLayerDeps;
}

describe("createRecordingLayer", () => {
  let container: HTMLElement;
  let deps: ReturnType<typeof makeDeps>;
  let layer: RecordingLayer;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    deps = makeDeps();
    layer = createRecordingLayer(container, deps);
  });

  afterEach(() => {
    layer.destroy();
    container.remove();
    vi.useRealTimers();
  });

  function root(): HTMLElement {
    return container.querySelector<HTMLElement>(".recording-layer")!;
  }

  it("starts idle: layer hidden, both adapters report idle", () => {
    expect(root().hidden).toBe(true);
    expect(layer.live.getState()).toBe("idle");
    expect(layer.batch.getState()).toBe("idle");
  });

  it("drives the full live flow: recording → processing → done → reset", () => {
    layer.live.start();
    expect(deps.live.onStart).toHaveBeenCalledTimes(1);
    expect(layer.live.getState()).toBe("recording");
    expect(root().hidden).toBe(false);

    // recbar with blinking-dot class + monospace elapsed <time>
    const recbar = root().querySelector<HTMLElement>(".recbar")!;
    expect(recbar.hidden).toBe(false);
    expect(recbar.querySelector(".recdot")).toBeTruthy();
    const time = recbar.querySelector<HTMLTimeElement>("time")!;
    expect(time.textContent).toBe("00:00");

    // Live does not support pause — no visible pause control.
    const pause = recbar.querySelector<HTMLButtonElement>(".pause-btn");
    expect(pause === null || pause.hidden).toBe(true);

    // draft block labelled; the layer owns the live transcript and mounts it
    // in the draft host (retire-v2-recording-shell — no external re-housing).
    const draft = root().querySelector<HTMLElement>(".draft")!;
    expect(draft.hidden).toBe(false);
    expect(draft.textContent).toContain("LIVE draft");
    expect(layer.els.draftHost.querySelector(".transcript-view")).toBeTruthy();
    expect(draft.contains(layer.els.draftHost)).toBe(true);

    // timer ticks to 00:02 after 2 s
    vi.advanceTimersByTime(2000);
    expect(time.textContent).toBe("00:02");

    // stop fires onStop; state flips only when main calls showProcessing()
    const stop = recbar.querySelector<HTMLButtonElement>(".stopbtn")!;
    expect(stop.textContent).toContain("Stop & save");
    stop.click();
    expect(deps.live.onStop).toHaveBeenCalledTimes(1);
    expect(layer.live.getState()).toBe("recording");

    layer.live.showProcessing();
    expect(layer.live.getState()).toBe("processing");
    const processing = root().querySelector<HTMLElement>(".processing")!;
    expect(processing.hidden).toBe(false);
    expect(processing.textContent).toContain("Processing…");
    expect(recbar.hidden).toBe(true);

    layer.live.markDone();
    expect(layer.live.getState()).toBe("done");
    const done = root().querySelector<HTMLElement>(".done-layout")!;
    expect(done.hidden).toBe(false);
    expect(done.querySelector("h3")!.textContent).toBe("Recording complete");
    expect(done.contains(layer.els.transcriptHost)).toBe(true);
    expect(done.contains(layer.els.actionsHost)).toBe(true);
    expect(done.contains(layer.els.answerHost)).toBe(true);

    // open-item only rendered once an action is provided
    expect(root().querySelector(".open-item")).toBeNull();
    const onOpen = vi.fn();
    layer.setDoneAction(onOpen);
    const openBtn = root().querySelector<HTMLButtonElement>(".open-item")!;
    expect(openBtn.textContent).toBe("Open item ›");
    openBtn.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    layer.setDoneAction(null);
    expect(root().querySelector(".open-item")).toBeNull();

    layer.live.reset();
    expect(layer.live.getState()).toBe("idle");
    expect(root().hidden).toBe(true);
  });

  it("batch flow: pause control freezes the timer, resume continues, discard fires", () => {
    layer.batch.start();
    expect(deps.batch.onStart).toHaveBeenCalledTimes(1);

    const recbar = root().querySelector<HTMLElement>(".recbar")!;
    const pause = recbar.querySelector<HTMLButtonElement>(".pause-btn")!;
    expect(pause.hidden).toBe(false);

    const time = recbar.querySelector<HTMLTimeElement>("time")!;
    vi.advanceTimersByTime(3000);
    expect(time.textContent).toBe("00:03");

    pause.click();
    expect(deps.batch.onPauseResume).toHaveBeenCalledTimes(1);
    expect(layer.batch.getState()).toBe("paused");
    vi.advanceTimersByTime(2000);
    expect(time.textContent).toBe("00:03"); // frozen while paused

    pause.click(); // resume
    expect(deps.batch.onPauseResume).toHaveBeenCalledTimes(2);
    expect(layer.batch.getState()).toBe("recording");
    vi.advanceTimersByTime(1000);
    expect(time.textContent).toBe("00:04"); // accumulated across the pause

    recbar.querySelector<HTMLButtonElement>(".discard-btn")!.click();
    expect(deps.batch.onDiscard).toHaveBeenCalledTimes(1);
  });

  it("mutual exclusion: starting batch while live is active is a no-op", () => {
    layer.live.start();
    layer.batch.start();
    expect(deps.batch.onStart).not.toHaveBeenCalled();
    expect(layer.batch.getState()).toBe("idle");
    expect(layer.live.getState()).toBe("recording");
  });

  it("confirming shows filename + duration and wires the two controls", () => {
    const file = new File(["x"], "voice.m4a", { type: "audio/mp4" });
    layer.batch.showConfirming(file, "0:42");
    expect(layer.batch.getState()).toBe("confirming");

    const row = root().querySelector<HTMLElement>(".confirm-row")!;
    expect(row.hidden).toBe(false);
    expect(row.textContent).toContain("voice.m4a");
    expect(row.textContent).toContain("0:42");

    const start = row.querySelector<HTMLButtonElement>(".confirm-start")!;
    expect(start.textContent).toBe("Start ▶");
    start.click();
    expect(deps.batch.onConfirmStart).toHaveBeenCalledTimes(1);

    const change = row.querySelector<HTMLButtonElement>(".confirm-change")!;
    expect(change.textContent).toBe("Change");
    change.click();
    expect(deps.batch.onConfirmChange).toHaveBeenCalledTimes(1);
  });

  it("setDisabled delegates to setEntriesDisabled with the title", () => {
    layer.live.setDisabled(true, "why");
    expect(deps.setEntriesDisabled).toHaveBeenCalledWith(true, "why");
    layer.live.setDisabled(false);
    expect(deps.setEntriesDisabled).toHaveBeenCalledWith(false, undefined);
  });

  it("subscribe emits active:true on start and active:false after reset", () => {
    const seen: Array<{ active: boolean; state: string; elapsedLabel: string }> = [];
    const unsubscribe = layer.subscribe((s) => seen.push(s));

    layer.live.start();
    expect(seen.at(-1)).toMatchObject({ active: true, state: "recording" });

    vi.advanceTimersByTime(1000);
    expect(seen.at(-1)).toMatchObject({ active: true, elapsedLabel: "00:01" });

    layer.live.reset();
    expect(seen.at(-1)).toMatchObject({ active: false, state: "idle" });

    unsubscribe();
    const count = seen.length;
    layer.live.start();
    expect(seen.length).toBe(count);
  });

  it("openFilePicker uses a hidden audio input and routes the pick to onFilePicked", () => {
    const input = root().querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.hidden).toBe(true);
    expect(input.accept).toBe("audio/*");

    layer.batch.openFilePicker(); // must not throw / start anything
    expect(layer.batch.getState()).toBe("idle");

    const file = new File(["x"], "memo.wav", { type: "audio/wav" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    expect(deps.batch.onFilePicked).toHaveBeenCalledWith(file);
  });

  it("showProcessing accepts an optional label (graceful-stop hint)", () => {
    layer.live.start();
    layer.live.showProcessing("Confirming last segment…");
    expect(
      root().querySelector(".processing-label")!.textContent,
    ).toBe("Confirming last segment…");

    // Default label restores when no argument is given.
    layer.live.reset();
    layer.live.start();
    layer.live.showProcessing();
    expect(
      root().querySelector(".processing-label")!.textContent,
    ).toBe("Processing…");
  });

  it("keeps the batch confirm controls usable while LIVE is disabled (pending upload)", () => {
    const file = new File(["x"], "memo.wav", { type: "audio/wav" });
    layer.batch.showConfirming(file, "0:09");
    // Legacy flow: a pending batch upload disables the live entry point.
    layer.live.setDisabled(true, "upload pending");
    const start = root().querySelector<HTMLButtonElement>(".confirm-start")!;
    const change = root().querySelector<HTMLButtonElement>(".confirm-change")!;
    expect(start.disabled).toBe(false);
    expect(change.disabled).toBe(false);
    start.click();
    expect(deps.batch.onConfirmStart).toHaveBeenCalledTimes(1);
  });

  it("drives the waveform through the capture lifecycle via the injected factory", () => {
    const wf = { start: vi.fn(), stop: vi.fn() };
    const factory = vi.fn(() => wf);
    layer.destroy();
    layer = createRecordingLayer(container, {
      ...deps,
      waveformFactory: factory,
    });
    // The recbar carries a waveform canvas; the factory wraps it once.
    const canvas = root().querySelector("canvas.rec-waveform");
    expect(canvas).toBeTruthy();
    expect(factory).toHaveBeenCalledWith(canvas);

    const stream = {} as MediaStream;
    layer.live.start();
    layer.startWaveform(stream);
    expect(wf.start).toHaveBeenCalledWith(stream);

    layer.live.showProcessing();
    expect(wf.stop).toHaveBeenCalledTimes(1);

    // Discard path: start again, then reset → stop again.
    layer.live.reset();
    layer.live.start();
    layer.startWaveform(stream);
    layer.live.reset();
    expect(wf.stop.mock.calls.length).toBeGreaterThanOrEqual(2);

    // startWaveform outside recording/paused is a no-op.
    const startCalls = wf.start.mock.calls.length;
    layer.startWaveform(stream);
    expect(wf.start.mock.calls.length).toBe(startCalls);
  });

  it("done state's close control returns the layer to idle (hero visible again)", () => {
    layer.live.start();
    layer.live.showProcessing();
    layer.live.markDone();
    expect(layer.live.getState()).toBe("done");

    const close = root().querySelector<HTMLButtonElement>(".done-close")!;
    expect(close).toBeTruthy();
    close.click();
    expect(layer.live.getState()).toBe("idle");
    expect(root().hidden).toBe(true);
  });

  it("allows starting a new capture from the done state", () => {
    layer.live.start();
    layer.live.showProcessing();
    layer.live.markDone();
    expect(layer.live.getState()).toBe("done");

    layer.batch.start();
    expect(deps.batch.onStart).toHaveBeenCalledTimes(1);
    expect(layer.batch.getState()).toBe("recording");
    expect(root().dataset.state).toBe("recording");
  });
});

describe("createRecordingLayer — live-captions toggle", () => {
  let container: HTMLElement;
  let onLiveToggle: ReturnType<typeof vi.fn>;
  let layer: RecordingLayer;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    onLiveToggle = vi.fn();
    layer = createRecordingLayer(container, { ...makeDeps(), onLiveToggle });
  });

  afterEach(() => {
    layer.destroy();
    container.remove();
    vi.useRealTimers();
  });

  function toggle(): HTMLInputElement {
    return container.querySelector<HTMLInputElement>(".live-toggle-input")!;
  }

  it("fires onLiveToggle on flip — attach then detach mid-recording", () => {
    layer.live.start(); // recbar visible
    const t = toggle();
    t.checked = true;
    t.dispatchEvent(new Event("change"));
    expect(onLiveToggle).toHaveBeenNthCalledWith(1, true);
    t.checked = false;
    t.dispatchEvent(new Event("change"));
    expect(onLiveToggle).toHaveBeenNthCalledWith(2, false);
    // Flipping the toggle never changes the recording state.
    expect(layer.live.getState()).toBe("recording");
  });

  it("setLiveToggle disables the control when the strategy is none", () => {
    layer.setLiveToggle({ available: false, on: false, hint: "no live" });
    expect(toggle().disabled).toBe(true);
    layer.setLiveToggle({ available: true, on: true });
    expect(toggle().disabled).toBe(false);
    expect(toggle().checked).toBe(true);
  });
});

// The recording layer owns the live transcript (retire-v2-recording-shell):
// it renders the same DOM the v2 TranscriptView produced and exposes the same
// six-method contract, so main.ts drives it without a standalone surface.
describe("createRecordingLayer — owned transcript", () => {
  let container: HTMLElement;
  let layer: RecordingLayer;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    layer = createRecordingLayer(container, makeDeps());
  });

  afterEach(() => {
    layer.destroy();
    container.remove();
    vi.useRealTimers();
  });

  function transcriptEl(): HTMLElement {
    return container.querySelector<HTMLElement>(".transcript-view")!;
  }
  function finalRows(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(".transcript-final")];
  }

  it("appendFinal adds a row and getText joins the finals", () => {
    layer.appendFinal({ text: "first", start_ms: 0, end_ms: 1000, kind: "live" });
    layer.appendFinal({ text: "second", start_ms: 2000, end_ms: 3000, kind: "live" });
    expect(finalRows().map((r) => r.querySelector(".transcript-text")?.textContent)).toEqual([
      "first",
      "second",
    ]);
    expect(layer.getText()).toBe("first\nsecond");
  });

  it("setPartial shows the in-flight text; getPartial reads it; clearPartial empties it", () => {
    layer.setPartial("typing…");
    expect(layer.getPartial()).toBe("typing…");
    expect(transcriptEl().querySelector(".transcript-partial")?.textContent).toBe("typing…");
    layer.clearPartial();
    expect(layer.getPartial()).toBe("");
  });

  it("appendFinal clears the partial (finals own the confirmed history)", () => {
    layer.setPartial("in flight");
    layer.appendFinal({ text: "done", start_ms: 0, end_ms: 500, kind: "live" });
    expect(layer.getPartial()).toBe("");
  });

  it("clear empties both finals and partial", () => {
    layer.appendFinal({ text: "a", start_ms: 0, end_ms: 1, kind: "live" });
    layer.setPartial("b");
    layer.clear();
    expect(finalRows()).toHaveLength(0);
    expect(layer.getPartial()).toBe("");
    expect(layer.getText()).toBe("");
  });

  it("live finals carry an mm:ss timestamp column; batch finals do not", () => {
    layer.appendFinal({ text: "live one", start_ms: 65_000, end_ms: 66_000, kind: "live" });
    layer.appendFinal({ text: "batch one", start_ms: 0, end_ms: 1000, kind: "batch" });
    const rows = finalRows();
    expect(rows[0].querySelector(".transcript-ts")?.textContent).toBe("01:05");
    expect(rows[1].querySelector(".transcript-ts")).toBeNull();
  });

  it("the transcript lives in the draft host while recording and the done host when done", () => {
    layer.live.start();
    expect(container.querySelector(".draft-host .transcript-view")).toBeTruthy();
    layer.live.showProcessing();
    layer.live.markDone();
    expect(container.querySelector(".done-layout .transcript-host .transcript-view")).toBeTruthy();
  });
});
