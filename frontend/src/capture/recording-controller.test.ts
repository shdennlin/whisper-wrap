import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createRecordingController,
  type RecordingController,
  type RecordingControllerDeps,
} from "./recording-controller";
import type { RecordingLayer } from "../ui/recording-view";
import { resetClientFetch, setClientFetch } from "../api/client";

// Each controller registers a `window` pagehide listener; track every one so
// afterEach can dispose them and keep the global window free of cross-test
// listener leaks.
const liveControllers: RecordingController[] = [];
function makeController(deps: RecordingControllerDeps): RecordingController {
  const rec = createRecordingController(deps);
  liveControllers.push(rec);
  return rec;
}

// ---- module mocks ----------------------------------------------------------
// The lifecycle constructs its collaborators directly (verbatim move), so we
// mock the modules to capture/controll the instances.

const h = vi.hoisted(() => ({
  captureSessions: [] as Array<{
    opts: unknown;
    state: string;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    getStream: ReturnType<typeof vi.fn>;
    attachLiveSink: ReturnType<typeof vi.fn>;
    detachLiveSink: ReturnType<typeof vi.fn>;
  }>,
  liveTimeouts: [] as Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onActivity: ReturnType<typeof vi.fn>;
  }>,
  liveSinks: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  // Toggled per-test so the at-construction `liveCaptionsEnabled` field varies.
  liveCaptionsDefault: false,
}));

vi.mock("./capture-session", () => ({
  CaptureSession: vi.fn().mockImplementation((opts: unknown) => {
    const session = {
      opts,
      state: "recording",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi
        .fn()
        .mockResolvedValue({ blob: new Blob(["x"]), durationMs: 5000 }),
      pause: vi.fn(),
      resume: vi.fn(),
      getStream: vi.fn().mockReturnValue(null),
      attachLiveSink: vi.fn(),
      detachLiveSink: vi.fn(),
    };
    h.captureSessions.push(session);
    return session;
  }),
  shouldWarnReTranscribe: () => false,
}));

vi.mock("./live-timeout", () => ({
  LiveTimeoutManager: vi.fn().mockImplementation(() => {
    const m = { start: vi.fn(), stop: vi.fn(), onActivity: vi.fn() };
    h.liveTimeouts.push(m);
    return m;
  }),
}));

vi.mock("./live-caption-strategy", () => ({
  createLiveSink: vi.fn().mockImplementation(() => {
    const sink = {
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      pushFrame: vi.fn(),
      onPartial: vi.fn(),
      onFinal: vi.fn(),
    };
    h.liveSinks.push(sink);
    return sink;
  }),
}));

vi.mock("../platform/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
}));

vi.mock("../ui/toast", () => ({
  toast: vi.fn(),
  toastWithAction: vi.fn(),
}));

// ---- helpers ---------------------------------------------------------------

function makeRecLayerMock(): RecordingLayer {
  const adapter = () => ({
    start: vi.fn(),
    setDisabled: vi.fn(),
    reset: vi.fn(),
    showProcessing: vi.fn(),
    showConfirming: vi.fn(),
    openFilePicker: vi.fn(),
    getState: vi.fn().mockReturnValue("recording"),
    markDone: vi.fn(),
  });
  return {
    live: adapter(),
    batch: adapter(),
    els: {
      root: document.createElement("div"),
      draftHost: document.createElement("div"),
      transcriptHost: document.createElement("div"),
      actionsHost: document.createElement("div"),
      answerHost: document.createElement("div"),
    },
    setDoneAction: vi.fn(),
    setReTranscribeAction: vi.fn(),
    setLiveToggle: vi.fn(),
    startWaveform: vi.fn(),
    appendFinal: vi.fn(),
    setPartial: vi.fn(),
    getPartial: vi.fn().mockReturnValue(""),
    clearPartial: vi.fn(),
    clear: vi.fn(),
    getText: vi.fn().mockReturnValue("hello world"),
    scrollTranscriptToEnd: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    destroy: vi.fn(),
  } as unknown as RecordingLayer;
}

function makeDeps(
  over: Partial<RecordingControllerDeps> = {},
): RecordingControllerDeps {
  const store = {
    prime: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
    startSession: vi.fn().mockReturnValue("sess-1"),
    appendFinal: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    uploadSessionAudio: vi.fn().mockResolvedValue(undefined),
  };
  const healthMonitor = {
    checkNow: vi.fn().mockResolvedValue("ok"),
    getState: vi.fn().mockReturnValue("ok"),
  };
  const settingsPanel = {
    getSettings: vi.fn().mockReturnValue({
      deviceId: null,
      liveIdleMinutes: 30,
      liveMaxMinutes: 240,
    }),
  };
  return {
    store: store as unknown as RecordingControllerDeps["store"],
    healthMonitor:
      healthMonitor as unknown as RecordingControllerDeps["healthMonitor"],
    recLayer: makeRecLayerMock(),
    liveStrategy: () => "windowed-batch" as const,
    settingsPanel:
      settingsPanel as unknown as RecordingControllerDeps["settingsPanel"],
    onLibraryChanged: vi.fn(),
    wsIndicatorHost: document.createElement("div"),
    uploadRetryHost: document.createElement("div"),
    resetAnswerPane: vi.fn(),
    showMicPermissionError: vi.fn(),
    onDoneItem: vi.fn(),
    ...over,
  };
}

// The single `fetch` the generated client calls (design "Preserve the test
// seam"). Both engine calls in this controller — POST /transcribe and the
// The batch-upload POST /transcribe routes through the generated client, so we
// stub its `fetch` seam. (The pagehide PATCH is a transport exemption on native
// `fetch` — those tests stub `globalThis.fetch` directly.)
let clientFetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.captureSessions.length = 0;
  h.liveTimeouts.length = 0;
  h.liveSinks.length = 0;
  localStorage.clear();
  // Real Response so openapi-fetch can read headers + parse JSON.
  clientFetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ text: "hello" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  setClientFetch(clientFetchMock as unknown as typeof fetch);
});

afterEach(() => {
  // Dispose every controller so its window pagehide listener is removed and
  // does not leak into the next test.
  while (liveControllers.length) liveControllers.pop()!.dispose();
  resetClientFetch();
  vi.clearAllMocks();
});

describe("createRecordingController", () => {
  it("is idle (activeSessionId null) when freshly constructed", () => {
    const rec = makeController(makeDeps());
    expect(rec.activeSessionId()).toBeNull();
  });

  it("gates start on an offline health check (no session created)", async () => {
    const deps = makeDeps();
    (deps.healthMonitor.checkNow as ReturnType<typeof vi.fn>).mockResolvedValue(
      "down",
    );
    const rec = makeController(deps);
    await rec.start();
    expect(deps.store.startSession).not.toHaveBeenCalled();
    expect(h.captureSessions).toHaveLength(0);
    expect(rec.activeSessionId()).toBeNull();
  });

  it("opens a session when healthy and reflects it via activeSessionId()", async () => {
    const deps = makeDeps();
    const rec = makeController(deps);
    await rec.start();
    expect(deps.store.startSession).toHaveBeenCalledTimes(1);
    expect(h.captureSessions).toHaveLength(1);
    expect(h.captureSessions[0]!.start).toHaveBeenCalled();
    expect(deps.recLayer.batch.start).toHaveBeenCalled();
    expect(rec.activeSessionId()).toBe("sess-1");
  });

  it("toggles capture state on pause/resume", async () => {
    const deps = makeDeps();
    const rec = makeController(deps);
    await rec.start();
    const session = h.captureSessions[0]!;

    (deps.recLayer.batch.getState as ReturnType<typeof vi.fn>).mockReturnValue(
      "paused",
    );
    await rec.togglePause();
    expect(session.pause).toHaveBeenCalled();

    (deps.recLayer.batch.getState as ReturnType<typeof vi.fn>).mockReturnValue(
      "recording",
    );
    await rec.togglePause();
    expect(session.resume).toHaveBeenCalled();
  });

  it("drops the session on discard and returns to idle", async () => {
    const deps = makeDeps();
    const rec = makeController(deps);
    await rec.start();
    const session = h.captureSessions[0]!;
    await rec.discard();
    expect(session.stop).toHaveBeenCalled();
    expect(deps.store.deleteSession).toHaveBeenCalledWith("sess-1");
    expect(rec.activeSessionId()).toBeNull();
  });

  it("attaches then detaches the live sink across a mid-recording toggle", async () => {
    const deps = makeDeps();
    const rec = makeController(deps);
    await rec.start();
    const session = h.captureSessions[0]!;

    rec.setLiveCaptions(true);
    expect(session.attachLiveSink).toHaveBeenCalled();

    rec.setLiveCaptions(false);
    expect(session.detachLiveSink).toHaveBeenCalled();
    // Capture continues uninterrupted — the session was never stopped.
    expect(session.stop).not.toHaveBeenCalled();
  });

  it("persists and finishes a stop with no live transcript", async () => {
    const deps = makeDeps();
    (deps.store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "sess-1", started_at: 1000, ended_at: null, finals: [] },
    ]);
    const rec = makeController(deps);
    await rec.start();
    await rec.stop();
    expect(deps.store.stopSession).toHaveBeenCalledWith("sess-1");
    expect(deps.onDoneItem).toHaveBeenCalledWith("sess-1");
    expect(deps.recLayer.batch.markDone).toHaveBeenCalled();
    expect(rec.activeSessionId()).toBeNull();
  });

  it("fires the best-effort pagehide PATCH for an in-flight session", async () => {
    const deps = makeDeps();
    (deps.store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "sess-1", started_at: 1000, ended_at: null, finals: [] },
    ]);
    const rec = makeController(deps);
    await rec.start();
    // The pagehide PATCH is a TRANSPORT EXEMPTION: it fires synchronously on
    // native `fetch` (not the client), so unload timing can't drop it. Stub the
    // global `fetch` and assert on the (url, init) it receives.
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    window.dispatchEvent(new Event("pagehide"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/v1/sessions/sess-1");
    expect(init.method).toBe("PATCH");
    expect(init.keepalive).toBe(true);
    const body = JSON.parse(init.body as string);
    expect(typeof body.ended_at).toBe("number");
    vi.unstubAllGlobals();
  });

  it("removes the pagehide listener on dispose()", async () => {
    const deps = makeDeps();
    (deps.store.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "sess-1", started_at: 1000, ended_at: null, finals: [] },
    ]);
    const rec = makeController(deps);
    await rec.start();
    rec.dispose();
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
