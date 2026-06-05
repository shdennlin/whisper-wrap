import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { HistoryStore, type SessionRecord } from "../storage/history-store";
import { HistoryView, type ActionChoice } from "./history-view";

function makeStore(records: SessionRecord[] = []): HistoryStore {
  const store = new HistoryStore({ backendUrl: () => "http://test" });
  store.__setCacheForTests(records);
  return store;
}

function seedRecord(
  id: string,
  opts: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_010_000,
    finals: [{ text: `transcript for ${id}`, start_ms: 0, end_ms: 1000 }],
    action_runs: [],
    ...opts,
  };
}

function mountView() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return { root };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("HistoryView — rail", () => {
  it("renders the empty-state message when the store is empty", () => {
    const { root } = mountView();
    const view = new HistoryView({ root, store: makeStore([]) });
    view.show(null);

    const rail = root.querySelector(".history-rail");
    expect(rail?.querySelector(".history-rail-empty")?.textContent).toBeTruthy();
  });

  it("renders one row per session in store order", () => {
    const records = [
      seedRecord("a", { started_at: 3 }),
      seedRecord("b", { started_at: 2 }),
      seedRecord("c", { started_at: 1 }),
    ];
    const { root } = mountView();
    const view = new HistoryView({ root, store: makeStore(records) });
    view.show(null);

    const ids = Array.from(root.querySelectorAll<HTMLElement>(".history-row")).map(
      (r) => r.dataset.id,
    );
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("marks the currently-selected row with .is-selected", () => {
    const records = [seedRecord("a"), seedRecord("b")];
    const { root } = mountView();
    const view = new HistoryView({ root, store: makeStore(records) });
    view.show("b");

    const selected = root.querySelectorAll(".history-row.is-selected");
    expect(selected.length).toBe(1);
    expect((selected[0] as HTMLElement).dataset.id).toBe("b");
  });

  it("clicking a rail row sets location.hash to #/history/<id>", () => {
    const records = [seedRecord("clicked")];
    const { root } = mountView();
    const view = new HistoryView({ root, store: makeStore(records) });
    view.show(null);

    window.location.hash = "";
    (root.querySelector(".history-row") as HTMLElement).click();
    expect(window.location.hash).toBe("#/history/clicked");
    view.destroy();
    window.location.hash = "";
  });
});

describe("HistoryView — search", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("filters the rail to sessions matching the query after 120 ms debounce", () => {
    const records = [
      seedRecord("a", {
        finals: [{ text: "buy milk", start_ms: 0, end_ms: 1 }],
      }),
      seedRecord("b", {
        finals: [{ text: "ship code", start_ms: 0, end_ms: 1 }],
      }),
    ];
    const { root } = mountView();
    const view = new HistoryView({ root, store: makeStore(records) });
    view.show(null);

    const input = root.querySelector<HTMLInputElement>(".history-search")!;
    input.value = "milk";
    input.dispatchEvent(new Event("input"));

    // Before the debounce fires, the rail still shows both.
    expect(root.querySelectorAll(".history-row").length).toBe(2);
    vi.advanceTimersByTime(120);
    const visibleIds = Array.from(
      root.querySelectorAll<HTMLElement>(".history-row"),
    ).map((r) => r.dataset.id);
    expect(visibleIds).toEqual(["a"]);

    // Clearing restores the full set.
    input.value = "";
    input.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(120);
    expect(root.querySelectorAll(".history-row").length).toBe(2);
  });

  it("coalesces rapid keystrokes into a single render", () => {
    const records = [
      seedRecord("a", {
        finals: [{ text: "alpha", start_ms: 0, end_ms: 1 }],
      }),
      seedRecord("b", {
        finals: [{ text: "beta", start_ms: 0, end_ms: 1 }],
      }),
    ];
    const { root } = mountView();
    const view = new HistoryView({ root, store: makeStore(records) });
    view.show(null);

    const input = root.querySelector<HTMLInputElement>(".history-search")!;
    for (const ch of ["a", "al", "alp", "alph", "alpha"]) {
      input.value = ch;
      input.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(50);
    }
    // Only after the final keystroke + 120 ms idle does the rail repaint.
    vi.advanceTimersByTime(120);
    const ids = Array.from(
      root.querySelectorAll<HTMLElement>(".history-row"),
    ).map((r) => r.dataset.id);
    expect(ids).toEqual(["a"]);
  });

  it("is case-insensitive", () => {
    const records = [
      seedRecord("a", {
        finals: [{ text: "Hello World", start_ms: 0, end_ms: 1 }],
      }),
    ];
    const { root } = mountView();
    const view = new HistoryView({ root, store: makeStore(records) });
    view.show(null);
    const input = root.querySelector<HTMLInputElement>(".history-search")!;
    input.value = "HELLO";
    input.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(120);
    expect(root.querySelectorAll(".history-row").length).toBe(1);
  });
});

describe("HistoryView — detail panel", () => {
  it("shows the empty-state when sessionId is null", () => {
    const { root } = mountView();
    const view = new HistoryView({
      root,
      store: makeStore([seedRecord("a")]),
    });
    view.show(null);
    expect(
      root.querySelector(".history-detail-empty")?.textContent,
    ).toBeTruthy();
  });

  it("shows the not-found state when sessionId is unknown", () => {
    const { root } = mountView();
    const view = new HistoryView({
      root,
      store: makeStore([seedRecord("a")]),
    });
    view.show("ghost");
    const empty = root.querySelector(".history-detail-empty");
    expect(empty).not.toBeNull();
  });

  it("renders meta, transcript, and runs heading for a populated session", () => {
    const record = seedRecord("rendered", {
      action_runs: [
        { id: 1, action_id: "a", prompt: "p", answer: "first", ran_at: 1 },
      ],
    });
    const { root } = mountView();
    const view = new HistoryView({
      root,
      store: makeStore([record]),
    });
    view.show("rendered");

    expect(
      root.querySelector(".history-detail-meta")?.textContent,
    ).toBeTruthy();
    expect(root.querySelector(".history-transcript")?.textContent).toBe(
      "transcript for rendered",
    );
    expect(root.querySelectorAll(".history-run").length).toBe(1);
  });

  it("orders runs by ran_at DESC (newest at the top)", () => {
    const record = seedRecord("ordered", {
      action_runs: [
        { id: 1, action_id: "a", prompt: "", answer: "old", ran_at: 100 },
        { id: 2, action_id: "a", prompt: "", answer: "new", ran_at: 300 },
        { id: 3, action_id: "a", prompt: "", answer: "mid", ran_at: 200 },
      ],
    });
    const { root } = mountView();
    const view = new HistoryView({
      root,
      store: makeStore([record]),
    });
    view.show("ordered");

    const answers = Array.from(
      root.querySelectorAll<HTMLElement>(".history-run-answer"),
    ).map((el) => el.textContent);
    expect(answers).toEqual(["new", "mid", "old"]);
  });

  it("uses resolveActionLabel for the run row label", () => {
    const record = seedRecord("labeled", {
      action_runs: [
        { id: 1, action_id: "polish", prompt: "", answer: "x", ran_at: 1 },
      ],
    });
    const { root } = mountView();
    const view = new HistoryView({
      root,
      store: makeStore([record]),
      resolveActionLabel: (id) => (id === "polish" ? "Polish text" : null),
    });
    view.show("labeled");
    expect(root.querySelector(".history-run-label")?.textContent).toBe(
      "Polish text",
    );
  });
});

describe("HistoryView — Add AI Action flow", () => {
  it("opens the picker on click and disables apply while the callback runs", async () => {
    const record = seedRecord("s");
    const store = makeStore([record]);
    const actions: ActionChoice[] = [
      { id: "summarize", label: "Summarise", template: "Summarise: {transcript}" },
    ];
    const callback = vi.fn(async (_sid: string, _aid: string, _prompt: string) => "ok");
    const appendSpy = vi
      .spyOn(store, "appendActionRun")
      .mockResolvedValue(undefined);

    const { root } = mountView();
    const view = new HistoryView({
      root,
      store,
      listActions: () => actions,
      runActionAgain: callback,
    });
    view.show("s");

    const button = root.querySelector<HTMLButtonElement>(
      '[data-testid="add-ai-action"]',
    )!;
    button.click();
    // Picker is visible with one <select> option.
    const picker = root.querySelector<HTMLElement>(
      '[data-testid="action-picker"]',
    )!;
    expect(picker.hidden).toBe(false);
    expect(picker.querySelectorAll("option").length).toBe(1);

    const apply = picker.querySelector<HTMLButtonElement>(
      ".history-action-apply",
    )!;
    apply.click();
    // While the callback resolves, flush the microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(callback).toHaveBeenCalledWith(
      "s",
      "summarize",
      "Summarise: transcript for s",
    );
    expect(appendSpy).toHaveBeenCalledWith("s", {
      action_id: "summarize",
      prompt: "Summarise: transcript for s",
      answer: "ok",
      ran_at: expect.any(Number),
    });
  });

  it("disables the Add button while a re-run is in flight (concurrent guard)", async () => {
    const record = seedRecord("s");
    const store = makeStore([record]);
    let resolveCb: (v: string) => void = () => {};
    const callback = vi.fn(
      () =>
        new Promise<string>((res) => {
          resolveCb = res;
        }),
    );

    const { root } = mountView();
    const view = new HistoryView({
      root,
      store,
      listActions: () => [
        { id: "a", label: "A", template: "x" },
      ],
      runActionAgain: callback,
    });
    view.show("s");

    const addBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="add-ai-action"]',
    )!;
    addBtn.click();
    const apply = root.querySelector<HTMLButtonElement>(
      ".history-action-apply",
    )!;
    apply.click();

    // First click started the in-flight callback. Subsequent clicks on the
    // Add button SHALL NOT trigger another callback invocation.
    expect(callback).toHaveBeenCalledTimes(1);
    expect(addBtn.disabled).toBe(true);

    addBtn.click();
    addBtn.click();
    expect(callback).toHaveBeenCalledTimes(1);

    // Resolving the promise re-enables the button.
    resolveCb("answer");
    vi.spyOn(store, "appendActionRun").mockResolvedValue(undefined);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(addBtn.disabled).toBe(false);
  });
});

describe("HistoryView — per-run delete", () => {
  let confirmSpy: MockInstance<(message?: string) => boolean>;

  afterEach(() => {
    confirmSpy?.mockRestore();
  });

  it("removes the row when confirm-and-resolve succeeds", async () => {
    const record = seedRecord("s", {
      action_runs: [
        { id: 7, action_id: "a", prompt: "", answer: "r", ran_at: 1 },
        { id: 8, action_id: "a", prompt: "", answer: "s", ran_at: 2 },
      ],
    });
    const store = makeStore([record]);
    vi.spyOn(store, "deleteRun").mockResolvedValue(undefined);
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const { root } = mountView();
    const view = new HistoryView({ root, store });
    view.show("s");

    expect(root.querySelectorAll(".history-run").length).toBe(2);
    const delBtn = root
      .querySelector<HTMLElement>('[data-run-id="7"]')!
      .querySelector<HTMLButtonElement>(".history-run-delete")!;
    delBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.deleteRun).toHaveBeenCalledWith("s", 7);
    expect(root.querySelectorAll(".history-run").length).toBe(1);
    expect(root.querySelector('[data-run-id="7"]')).toBeNull();
    expect(root.querySelector('[data-run-id="8"]')).not.toBeNull();
  });

  it("leaves the row in place when the store rejects", async () => {
    const record = seedRecord("s", {
      action_runs: [
        { id: 1, action_id: "a", prompt: "", answer: "x", ran_at: 1 },
      ],
    });
    const store = makeStore([record]);
    vi.spyOn(store, "deleteRun").mockRejectedValue(new Error("boom"));
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const { root } = mountView();
    const view = new HistoryView({ root, store });
    view.show("s");

    (
      root
        .querySelector<HTMLElement>('[data-run-id="1"]')!
        .querySelector<HTMLButtonElement>(".history-run-delete")!
    ).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector('[data-run-id="1"]')).not.toBeNull();
  });

  it("does nothing when the user cancels the confirm dialog", async () => {
    const record = seedRecord("s", {
      action_runs: [
        { id: 9, action_id: "a", prompt: "", answer: "x", ran_at: 1 },
      ],
    });
    const store = makeStore([record]);
    const spy = vi.spyOn(store, "deleteRun").mockResolvedValue(undefined);
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    const { root } = mountView();
    const view = new HistoryView({ root, store });
    view.show("s");

    (
      root
        .querySelector<HTMLElement>('[data-run-id="9"]')!
        .querySelector<HTMLButtonElement>(".history-run-delete")!
    ).click();
    expect(spy).not.toHaveBeenCalled();
    expect(root.querySelector('[data-run-id="9"]')).not.toBeNull();
  });
});

describe("HistoryView — lifecycle", () => {
  it("destroy() removes the root container and clears state", () => {
    const { root } = mountView();
    const view = new HistoryView({
      root,
      store: makeStore([seedRecord("a")]),
    });
    view.show("a");
    expect(root.querySelector(".history-view")).not.toBeNull();
    view.destroy();
    expect(root.querySelector(".history-view")).toBeNull();
  });

  it("hide() preserves DOM (subsequent show() restores the view)", () => {
    const { root } = mountView();
    const view = new HistoryView({
      root,
      store: makeStore([seedRecord("a")]),
    });
    view.show("a");
    view.hide();
    expect(
      (root.querySelector<HTMLElement>(".history-view"))?.hidden,
    ).toBe(true);
    view.show("a");
    expect(
      (root.querySelector<HTMLElement>(".history-view"))?.hidden,
    ).toBe(false);
  });
});

describe("HistoryView — mobile-density layout", () => {
  // After the rail-row simplification: each rail row should be just a date
  // + duration head and a preview line. The 6-button cluster (Copy / Copy AI
  // / Export×3 / Delete) lives in the detail panel only. Re-introducing
  // those buttons on the rail would balloon each row to ~5 lines again.

  it("rail rows have NO inline action buttons", () => {
    const records = [seedRecord("a"), seedRecord("b")];
    const { root } = mountView();
    const view = new HistoryView({ root, store: makeStore(records) });
    view.show(null);

    const rows = root.querySelectorAll(".history-row");
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.querySelectorAll("button").length).toBe(0);
      expect(r.querySelector(".history-row-actions")).toBeNull();
    }
  });

  it("detail panel renders the action row (Copy / Copy AI / Export×3 / Delete)", () => {
    const { root } = mountView();
    const view = new HistoryView({
      root,
      store: makeStore([seedRecord("a")]),
    });
    view.show("a");

    const actions = root.querySelector(".history-detail-actions");
    expect(actions).not.toBeNull();
    expect(actions!.querySelectorAll("button").length).toBe(6);
  });

  it("detail header omits the date (now shown in the rail row only)", () => {
    const record = seedRecord("a", {
      started_at: new Date("2026-05-19T11:25:55").getTime(),
    });
    const { root } = mountView();
    const view = new HistoryView({ root, store: makeStore([record]) });
    view.show("a");

    const meta = root.querySelector(".history-detail-meta")?.textContent ?? "";
    expect(meta).not.toContain("2026-05-19");
    expect(meta).not.toContain("11:25:55");
  });
});

describe("HistoryView — Re-transcribe button (regression guard)", () => {
  // Regression check for the 04aaf11 → 10ac686 timeline: the audio-replay /
  // re-ASR feature shipped a Re-transcribe button in the old HistoryPanel.
  // The master-detail rewrite that replaced HistoryPanel with HistoryView
  // accidentally dropped the wiring. These tests assert that the button is
  // rendered exactly when the session has stored audio AND the host wired
  // in reAsrDeps + reAsrDefaults.

  const audioRecord = {
    session_id: "a",
    mime_type: "audio/webm",
    blob: new Blob(["x"], { type: "audio/webm" }),
    duration_ms: 1000,
    byte_size: 1,
    stored_at: 0,
  };

  const reAsrDeps = {
    transcribe: async () => "redo",
    appendActionRun: () => {},
  };

  const reAsrDefaults = () => ({
    prompt: "",
    language: "",
    languages: [{ value: "", label: "auto" }],
  });

  it("renders the toggle when reAsrDeps + audio record are both present", async () => {
    const { root } = mountView();
    const view = new HistoryView({
      root,
      store: makeStore([seedRecord("a")]),
      getAudio: async () => audioRecord,
      reAsrDeps,
      reAsrDefaults,
    });
    view.show("a");

    await vi.waitFor(() => {
      expect(
        root.querySelector("[data-testid='re-asr-toggle']"),
      ).not.toBeNull();
    });
  });

  it("hides the toggle when no audio record is available", async () => {
    const { root } = mountView();
    const view = new HistoryView({
      root,
      store: makeStore([seedRecord("a")]),
      getAudio: async () => null,
      reAsrDeps,
      reAsrDefaults,
    });
    view.show("a");

    // Wait long enough for getAudio to resolve and attachPlayer to finish.
    await new Promise((r) => setTimeout(r, 0));
    expect(
      root.querySelector("[data-testid='re-asr-toggle']"),
    ).toBeNull();
  });

  it("hides the toggle when reAsrDeps is not wired", async () => {
    const { root } = mountView();
    const view = new HistoryView({
      root,
      store: makeStore([seedRecord("a")]),
      getAudio: async () => audioRecord,
      // No reAsrDeps / reAsrDefaults — simulates a host that opted out.
    });
    view.show("a");

    await new Promise((r) => setTimeout(r, 0));
    expect(
      root.querySelector("[data-testid='re-asr-toggle']"),
    ).toBeNull();
  });

  it("hides the toggle after click and mounts the inline form", async () => {
    const { root } = mountView();
    const view = new HistoryView({
      root,
      store: makeStore([seedRecord("a")]),
      getAudio: async () => audioRecord,
      reAsrDeps,
      reAsrDefaults,
    });
    view.show("a");

    const toggle = await vi.waitFor(() => {
      const b = root.querySelector<HTMLButtonElement>(
        "[data-testid='re-asr-toggle']",
      );
      if (!b) throw new Error("toggle not yet rendered");
      return b;
    });
    toggle.click();
    expect(toggle.hidden).toBe(true);
    expect(root.querySelector(".re-asr-form")).not.toBeNull();
  });
});
