import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderDetail } from "./detail-view";
import { WaveformPlayer } from "./waveform-player";
import type { Run, RunKind } from "../library/runs-api";
import type { SessionFull } from "../storage/history-api-client";
import { resetClientFetch, setClientFetch } from "../api/client";

/** A JSON Response for the client's injectable `fetch` seam. */
function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function run(p: Partial<Run> & { id: string; kind: RunKind; status: Run["status"] }): Run {
  return {
    item_id: "i",
    model: null,
    progress: 1,
    stage: null,
    result_ref: null,
    error: null,
    created_at: 0,
    updated_at: 0,
    result: null,
    ...p,
  };
}

/** Stub audio loader that never resolves with a player (rejects fast). */
const noAudio = async (): Promise<Blob> => {
  throw new Error("no audio");
};

describe("renderDetail", () => {
  let container: HTMLElement;

  beforeEach(() => {
    history.replaceState(null, "", "#/item/i");
    container = document.createElement("div");
    document.body.appendChild(container);
    // happy-dom may lack createObjectURL; the player needs it.
    if (typeof URL.createObjectURL !== "function") {
      Object.assign(URL, {
        createObjectURL: () => "blob:mock",
        revokeObjectURL: () => {},
      });
    }
  });
  afterEach(() => {
    container.remove();
    // The AI picker modal mounts on document.body, outside `container`.
    for (const el of document.querySelectorAll(".ai-modal-overlay")) el.remove();
    history.replaceState(null, "", "#/");
    resetClientFetch();
  });

  it("groups runs by kind and selects the latest", async () => {
    const runs = [
      run({ id: "t1", kind: "transcribe", status: "done", result: { segments: [{ text: "舊" }] } }),
      run({ id: "t2", kind: "transcribe", status: "done", result: { segments: [{ text: "新" }] } }),
      run({ id: "d1", kind: "diarize", status: "error", error: "no models" }),
    ];
    await renderDetail(container, "i", { loadRuns: async () => runs, loadAudio: noAudio });

    expect(container.querySelector('.run-group[data-kind="transcribe"]')!.querySelectorAll(".run-row")).toHaveLength(2);
    expect(container.querySelector('.run-group[data-kind="diarize"]')).toBeTruthy();
    // latest transcript (t2) selected, snapshot shows its text
    expect(container.querySelector<HTMLElement>(".run-snapshot")!.dataset.runId).toBe("t2");
    expect(container.querySelector(".run-snapshot")!.textContent).toContain("新");
  });

  it("disables the AI re-run until a completed transcribe run exists", async () => {
    const noTranscript = [run({ id: "d1", kind: "diarize", status: "done" })];
    await renderDetail(container, "i", { loadRuns: async () => noTranscript, loadAudio: noAudio });
    expect(container.querySelector<HTMLButtonElement>('.stage-btn[data-kind="ai"]')!.disabled).toBe(true);

    container.replaceChildren();
    const withTranscript = [run({ id: "t1", kind: "transcribe", status: "done" })];
    await renderDetail(container, "i", { loadRuns: async () => withTranscript, loadAudio: noAudio });
    expect(container.querySelector<HTMLButtonElement>('.stage-btn[data-kind="ai"]')!.disabled).toBe(false);
  });

  it("selecting an older run shows that version's snapshot", async () => {
    const runs = [
      run({ id: "t1", kind: "transcribe", status: "done", result: { segments: [{ text: "舊版" }] } }),
      run({ id: "t2", kind: "transcribe", status: "done", result: { segments: [{ text: "新版" }] } }),
    ];
    await renderDetail(container, "i", { loadRuns: async () => runs, loadAudio: noAudio });
    const oldRow = container.querySelector<HTMLElement>('.run-row[data-run-id="t1"]')!;
    oldRow.click();
    expect(container.querySelector<HTMLElement>(".run-snapshot")!.dataset.runId).toBe("t1");
    expect(container.querySelector(".run-snapshot")!.textContent).toContain("舊版");
  });

  it("clicking a re-run button calls the stage client with item + kind", async () => {
    const startStage = vi.fn(async () => "new-run");
    await renderDetail(container, "i", {
      loadRuns: async () => [run({ id: "t1", kind: "transcribe", status: "done" })],
      startStage,
      loadAudio: noAudio,
      // Re-run needs stored audio, or the buttons are disabled.
      loadSession: async () =>
        ({ id: "i", audio_path: "/a.webm", finals: [] }) as unknown as SessionFull,
    });
    container.querySelector<HTMLButtonElement>('.stage-btn[data-kind="diarize"]')!.click();
    await Promise.resolve();
    // Diarize rerun omits quality so the engine resolves an installed tier
    // (default_installed) — hardcoding "fast" 503s on a balanced-only install.
    expect(startStage).toHaveBeenCalledWith("i", "diarize", {});
  });

  it("disables Re-run Transcribe/Diarize when the item has no stored audio", async () => {
    // A quick capture with audio-save off has a transcript (finals → a capture
    // run) but no recording — there is nothing for transcribe/diarize to process,
    // so the engine would 409. Disable the buttons with a reason instead.
    const startStage = vi.fn(async () => "x");
    await renderDetail(container, "i", {
      loadRuns: async () => [run({ id: "t1", kind: "transcribe", status: "done" })],
      startStage,
      loadAudio: noAudio,
      loadSession: async () =>
        ({ id: "i", audio_path: null, finals: [] }) as unknown as SessionFull,
    });
    for (const kind of ["transcribe", "diarize"]) {
      const btn = container.querySelector<HTMLButtonElement>(`.stage-btn[data-kind="${kind}"]`)!;
      expect(btn.disabled).toBe(true);
      expect(btn.dataset.disabledReason).toBe("no-audio");
      btn.click();
    }
    await Promise.resolve();
    expect(startStage).not.toHaveBeenCalled();
  });

  it("opens the AI picker modal and runs the picked action as an ai run", async () => {
    const startStage = vi.fn(async () => "ai-run");
    await renderDetail(container, "i", {
      loadRuns: async () => [run({ id: "t1", kind: "transcribe", status: "done" })],
      startStage,
      loadActions: async () => ({
        actions: [{ id: "sum", label: "Summary", template: "摘要：{transcript}" }],
        categories: [],
      }),
      loadAiStatus: async () => ({ configured: true, provider: "gemini", endpoint: "" }),
      loadAudio: noAudio,
    });

    const aiBtn = container.querySelector<HTMLButtonElement>('.stage-btn[data-kind="ai"]')!;
    expect(aiBtn.disabled).toBe(false);
    aiBtn.click();
    // Modal mounts and ActionsBar loads the templates.
    await new Promise((r) => setTimeout(r, 0));
    const modal = document.querySelector(".ai-modal")!;
    expect(modal).toBeTruthy();

    const chip = modal.querySelector<HTMLButtonElement>('.actions-chip[data-action-id="sum"]')!;
    chip.click();
    await new Promise((r) => setTimeout(r, 0));
    // getTranscript() is "" in the modal, so the template collapses to the bare
    // instruction; the ai stage appends the transcript server-side.
    expect(startStage).toHaveBeenCalledWith("i", "ai", { prompt: "摘要：" });
  });

  it("renders the document + inspector two-column layout", async () => {
    const runs = [
      run({ id: "t1", kind: "transcribe", status: "done", result: { segments: [{ text: "hi" }] } }),
    ];
    await renderDetail(container, "i", { loadRuns: async () => runs, loadAudio: noAudio });

    const wrap = container.querySelector(".detail-wrap")!;
    expect(wrap).toBeTruthy();
    const doc = wrap.querySelector(".doc")!;
    expect(doc).toBeTruthy();
    expect(doc.parentElement).toBe(wrap);
    const rail = wrap.querySelector("aside.inspector")!;
    expect(rail).toBeTruthy();
    expect(rail.parentElement).toBe(wrap);

    // doc column: title row, badge row, transcript content
    expect(doc.querySelector(".detail-title")!.textContent).toBe("i");
    expect(doc.querySelector(".detail-back")).toBeTruthy();
    const badges = doc.querySelectorAll(".meta .badge");
    expect(badges.length).toBeGreaterThan(0);
    const badgeText = [...badges].map((b) => b.textContent).join(" ");
    // User-facing labels, not the internal kind/status jargon.
    expect(badgeText).toContain("Transcribe");
    expect(badgeText).toContain("Done");
    expect(doc.querySelector(".run-snapshot")).toBeTruthy();

    // inspector rail: h4 section headers, run groups, stage buttons, askbar
    const headers = [...rail.querySelectorAll("h4")].map((h) => h.textContent);
    expect(headers).toContain("History");
    expect(rail.querySelector(".run-inspector .run-group")).toBeTruthy();
    expect(rail.querySelector('.stage-btn[data-kind="transcribe"]')).toBeTruthy();
    expect(rail.querySelector(".askbar")).toBeTruthy();
  });

  it("renders speaker turns with stable per-speaker classes", async () => {
    const runs = [
      run({
        id: "d1",
        kind: "diarize",
        status: "done",
        result: {
          segments: [
            { text: "first", speaker: "A", start: 0 },
            { text: "second", speaker: "B", start: 65 },
            { text: "third", speaker: "A", start: 90 },
          ],
        },
      }),
    ];
    await renderDetail(container, "i", { loadRuns: async () => runs, loadAudio: noAudio });
    // Timestamps are timeline-only; switch out of the default article layout.
    container.querySelector<HTMLButtonElement>(".timeline-toggle")!.click();

    const turns = [...container.querySelectorAll<HTMLElement>(".run-snapshot .turn")];
    expect(turns).toHaveLength(3);

    const bucket = (el: HTMLElement) =>
      [...el.classList].find((c) => /^c[1-3]$/.test(c));
    // every speakered turn lands in one of the 3 buckets
    for (const t of turns) expect(bucket(t)).toMatch(/^c[1-3]$/);
    // stable: same speaker, same class; distinct speakers map apart here
    expect(bucket(turns[0])).toBe(bucket(turns[2]));
    expect(bucket(turns[0])).not.toBe(bucket(turns[1]));

    // .who carries speaker name + .t timestamp
    const who = turns[0].querySelector(".who")!;
    expect(who.textContent).toContain("A");
    expect(who.querySelector(".t")!.textContent).toBe("0:00");
    expect(turns[1].querySelector(".who .t")!.textContent).toBe("1:05");
    expect(turns[0].querySelector("p")!.textContent).toBe("first");
  });

  it("renders speakerless segments as turns without who", async () => {
    const runs = [
      run({
        id: "t1",
        kind: "transcribe",
        status: "done",
        result: { segments: [{ text: "plain", start: 12 }] },
      }),
    ];
    await renderDetail(container, "i", { loadRuns: async () => runs, loadAudio: noAudio });
    // Timestamps are timeline-only; switch out of the default article layout.
    container.querySelector<HTMLButtonElement>(".timeline-toggle")!.click();

    const turn = container.querySelector<HTMLElement>(".run-snapshot .turn")!;
    expect(turn).toBeTruthy();
    expect(turn.querySelector(".who")).toBeNull();
    expect(turn.querySelector(".t")!.textContent).toBe("0:12");
    expect(turn.querySelector("p")!.textContent).toBe("plain");
  });

  it("keeps the raw snapshot fallback for unrecognized results", async () => {
    const runs = [
      run({ id: "a1", kind: "ai", status: "done", result: { note: "42" } }),
    ];
    await renderDetail(container, "i", { loadRuns: async () => runs, loadAudio: noAudio });

    expect(container.querySelector(".run-snapshot .turn")).toBeNull();
    expect(container.querySelector(".snapshot-body")!.textContent).toContain("42");
  });

  it("mounts the waveform player capsule when audio loads", async () => {
    const loadAudio = vi.fn(async () => new Blob(["x"], { type: "audio/webm" }));
    await renderDetail(container, "i", {
      loadRuns: async () => [run({ id: "t1", kind: "transcribe", status: "done" })],
      loadAudio,
    });

    expect(loadAudio).toHaveBeenCalledWith("i");
    const player = container.querySelector(".player")!;
    expect(player).toBeTruthy();
    // The waveform "voice bar": play button + waveform canvas, not a native
    // <audio controls> strip.
    expect(player.classList.contains("waveform-player")).toBe(true);
    expect(player.querySelector(".waveform-canvas")).toBeTruthy();
    expect(player.querySelector(".waveform-play")).toBeTruthy();
  });

  it("renders no player when audio loading fails", async () => {
    await renderDetail(container, "i", {
      loadRuns: async () => [run({ id: "t1", kind: "transcribe", status: "done" })],
      loadAudio: noAudio,
    });

    expect(container.querySelector(".player")).toBeNull();
    // the rest of the view is untouched
    expect(container.querySelector(".run-snapshot")).toBeTruthy();
  });

  it("disables the AI button until a transcript run exists (DAG gate)", async () => {
    await renderDetail(container, "i", {
      loadRuns: async () => [run({ id: "d1", kind: "diarize", status: "done" })],
      loadAiStatus: async () => ({ configured: false, provider: "", endpoint: "" }),
      loadAudio: noAudio,
    });

    const askbar = container.querySelector(".askbar")!;
    expect(askbar).toBeTruthy();
    const aiBtn = askbar.querySelector<HTMLButtonElement>('.stage-btn[data-kind="ai"]')!;
    expect(aiBtn.disabled).toBe(true);
    expect(aiBtn.title).toBe("Needs a completed transcribe run first (DAG prerequisite)");
    expect(aiBtn.dataset.disabledReason).toBe("no-transcript");
  });

  it("renders the capture transcript from a synthesized capture run", async () => {
    // The backend surfaces a quick capture's finals as a read-only capture
    // transcribe run (unify-run-ledger); the view renders it like any
    // transcript — no session.finals special-case.
    const runs = [
      run({
        id: "capture:i",
        kind: "transcribe",
        status: "done",
        origin: "capture",
        result: { segments: [{ text: "第一句", start: 0 }, { text: "第二句", start: 2 }] },
      }),
    ];
    await renderDetail(container, "i", { loadRuns: async () => runs, loadAudio: noAudio });
    const turns = container.querySelectorAll(".run-snapshot .turn");
    expect(turns.length).toBe(2);
    expect(turns[0]!.textContent).toContain("第一句");
    // Selected by default (latest transcribe) — its badge is Transcribe.
    expect(container.querySelector(".meta")!.textContent).toContain("Transcribe");
  });

  it("shows a hint when an item has no runs at all", async () => {
    await renderDetail(container, "i", {
      loadRuns: async () => [],
      loadAudio: noAudio,
      loadSession: async () => null,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector(".snapshot-empty")).toBeTruthy();
  });

  it("marks synthesized capture/legacy runs read-only with no per-run controls; stage runs stay normal", async () => {
    const runs = [
      run({
        id: "capture:i",
        kind: "transcribe",
        status: "done",
        origin: "capture",
        result: { segments: [{ text: "稿" }] },
      }),
      run({ id: "d1", kind: "diarize", status: "done", result: { segments: [{ text: "x", speaker: "A", start: 0 }] } }),
      run({ id: "legacy:5", kind: "ai", status: "done", origin: "legacy", result: { answer: "嗨答案" } }),
    ];
    await renderDetail(container, "i", { loadRuns: async () => runs, loadAudio: noAudio });

    const cap = container.querySelector<HTMLElement>('.run-row[data-run-id="capture:i"]')!;
    expect(cap.dataset.origin).toBe("capture");
    expect(cap.classList.contains("read-only")).toBe(true);
    // The row is a pure selector — no nested re-run/delete control.
    expect(cap.querySelector("button")).toBeNull();

    const legacy = container.querySelector<HTMLElement>('.run-row[data-run-id="legacy:5"]')!;
    expect(legacy.dataset.origin).toBe("legacy");
    expect(legacy.classList.contains("read-only")).toBe(true);
    // Clicking only selects → shows that run's answer snapshot.
    legacy.click();
    expect(container.querySelector<HTMLElement>(".run-snapshot")!.dataset.runId).toBe("legacy:5");
    expect(container.querySelector(".run-snapshot")!.textContent).toContain("嗨答案");

    // A real ledger run defaults to stage origin and is NOT read-only.
    const stage = container.querySelector<HTMLElement>('.run-row[data-run-id="d1"]')!;
    expect(stage.dataset.origin).toBe("stage");
    expect(stage.classList.contains("read-only")).toBe(false);
  });

  it("deletes the item after the confirm modal and returns to Library", async () => {
    const deleteItem = vi.fn(async () => undefined);
    await renderDetail(container, "i", {
      loadRuns: async () => [run({ id: "t1", kind: "transcribe", status: "done" })],
      loadAudio: noAudio,
      deleteItem,
    });

    const del = container.querySelector<HTMLButtonElement>(".detail-delete")!;
    expect(del).toBeTruthy();
    del.click();
    // The WKWebView-safe modal renders into document.body; confirm it.
    const ok = document.body.querySelector<HTMLButtonElement>(".modal-prompt-ok")!;
    expect(ok).toBeTruthy();
    ok.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(deleteItem).toHaveBeenCalledWith("i");
    expect(window.location.hash).toBe("#/library");
  });

  it("defaultLoadAiStatus routes GET /status through the generated client", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResp({
        ai: { configured: true, provider: "gemini", endpoint: "http://e", model: "m" },
      }),
    );
    setClientFetch(fetchMock as unknown as typeof fetch);

    // Omit loadAiStatus so the default (client GET /status) runs; inject the
    // other loaders so /status is the only client call this render makes.
    await renderDetail(container, "i", {
      loadRuns: async () => [run({ id: "t1", kind: "transcribe", status: "done" })],
      loadAudio: noAudio,
      loadSession: async () => null,
    });

    const statusReq = fetchMock.mock.calls
      .map((c) => (c as unknown[])[0] as Request)
      .find((r) => new URL(r.url).pathname === "/status");
    expect(statusReq).toBeTruthy();
    expect(statusReq!.method).toBe("GET");
  });

  it("defaultLoadActions routes GET /actions through the generated client", async () => {
    const fetchMock = vi.fn(async (input: Request) => {
      const path = new URL(input.url).pathname;
      if (path === "/actions") {
        return jsonResp({
          actions: [{ id: "sum", label: "Summary", template: "摘要：{transcript}" }],
          categories: [],
        });
      }
      // /status for the default AI-status probe.
      return jsonResp({ ai: { configured: false, provider: "", endpoint: "", model: "" } });
    });
    setClientFetch(fetchMock as unknown as typeof fetch);

    // Omit loadActions + loadAiStatus so both defaults (client) are exercised.
    await renderDetail(container, "i", {
      loadRuns: async () => [run({ id: "t1", kind: "transcribe", status: "done" })],
      loadAudio: noAudio,
      loadSession: async () => null,
    });

    container.querySelector<HTMLButtonElement>('.stage-btn[data-kind="ai"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    const actionsReq = fetchMock.mock.calls
      .map((c) => c[0] as Request)
      .find((r) => new URL(r.url).pathname === "/actions");
    expect(actionsReq?.method).toBe("GET");
    // The chip rendered from the client-loaded registry.
    expect(document.querySelector('.actions-chip[data-action-id="sum"]')).toBeTruthy();
  });

  it("does not delete when the confirm modal is cancelled", async () => {
    const deleteItem = vi.fn(async () => undefined);
    await renderDetail(container, "i", {
      loadRuns: async () => [run({ id: "t1", kind: "transcribe", status: "done" })],
      loadAudio: noAudio,
      deleteItem,
    });

    container.querySelector<HTMLButtonElement>(".detail-delete")!.click();
    document.body.querySelector<HTMLButtonElement>(".modal-prompt-cancel")!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(deleteItem).not.toHaveBeenCalled();
  });

  it("clicking a transcript segment seeks the player; a wordless snapshot seeks at segment level", async () => {
    const seekSpy = vi
      .spyOn(WaveformPlayer.prototype, "seekTo")
      .mockImplementation(() => {});
    const runs = [
      run({
        id: "t1",
        kind: "transcribe",
        status: "done",
        result: { segments: [{ text: "hello", start: 3, end: 5 }] },
      }),
    ];
    await renderDetail(container, "i", {
      loadRuns: async () => runs,
      loadAudio: async () => new Blob(["x"]),
    });

    const turn = container.querySelector<HTMLElement>(".turn")!;
    turn.click();
    expect(seekSpy).toHaveBeenCalledWith(3);
    seekSpy.mockRestore();
  });

  it("clicking a word seeks to that word's start", async () => {
    const seekSpy = vi
      .spyOn(WaveformPlayer.prototype, "seekTo")
      .mockImplementation(() => {});
    const runs = [
      run({
        id: "t1",
        kind: "transcribe",
        status: "done",
        result: {
          segments: [
            {
              text: "ab",
              start: 1,
              end: 4,
              words: [
                { word: "a", start: 1, end: 2 },
                { word: "b", start: 2, end: 4 },
              ],
            },
          ],
        },
      }),
    ];
    await renderDetail(container, "i", {
      loadRuns: async () => runs,
      loadAudio: async () => new Blob(["x"]),
    });

    const words = container.querySelectorAll<HTMLElement>(".segment-word");
    expect(words).toHaveLength(2);
    words[1].click(); // "b" → its own start, not the segment start
    expect(seekSpy).toHaveBeenLastCalledWith(2);
    seekSpy.mockRestore();
  });

  it("renders a diarize run as speaker-labeled turns from the transcript, not raw JSON", async () => {
    const runs = [
      run({
        id: "t1",
        kind: "transcribe",
        status: "done",
        result: {
          segments: [
            { text: "hi", start: 0, end: 2 },
            { text: "yo", start: 2, end: 4 },
            { text: "zz", start: 10, end: 12 },
          ],
        },
      }),
      run({
        id: "d1",
        kind: "diarize",
        status: "done",
        result: {
          quality: "balanced",
          speakers: [
            { start: 0, end: 2, speaker: "SPEAKER_00" },
            { start: 2, end: 4, speaker: "SPEAKER_01" },
          ],
        },
      }),
    ];
    await renderDetail(container, "i", {
      loadRuns: async () => runs,
      loadAudio: noAudio,
    });

    container.querySelector<HTMLElement>('.run-row[data-run-id="d1"]')!.click();
    const snap = container.querySelector<HTMLElement>(".run-snapshot")!;
    // Not the raw-JSON fallback.
    expect(snap.querySelector(".snapshot-body")).toBeNull();
    expect(snap.querySelectorAll(".turn")).toHaveLength(3);
    expect(snap.textContent).toContain("SPEAKER_00");
    expect(snap.textContent).toContain("SPEAKER_01");
    // "zz" overlaps no speaker turn → rendered without a speaker label.
    expect(snap.querySelectorAll(".who")).toHaveLength(2);
    // Speakered turns are marked so article mode keeps them on their own line.
    expect(snap.querySelectorAll(".turn.has-speaker")).toHaveLength(2);
  });

  it("renders an AI run's answer as readable text, not raw JSON", async () => {
    const runs = [
      run({
        id: "t1",
        kind: "transcribe",
        status: "done",
        result: { segments: [{ text: "hi", start: 0, end: 1 }] },
      }),
      run({
        id: "a1",
        kind: "ai",
        status: "done",
        result: { answer: "This is the summary.", prompt: "Summarize the key points" },
      }),
    ];
    await renderDetail(container, "i", {
      loadRuns: async () => runs,
      loadAudio: noAudio,
    });

    container.querySelector<HTMLElement>('.run-row[data-run-id="a1"]')!.click();
    const snap = container.querySelector<HTMLElement>(".run-snapshot")!;
    expect(snap.querySelector(".snapshot-body")).toBeNull(); // not the raw-JSON fallback
    expect(snap.textContent).toContain("This is the summary.");
    expect(snap.querySelector(".turn")).not.toBeNull();
    // The prompt that produced the answer is shown above it.
    expect(snap.querySelector(".ai-prompt")!.textContent).toContain(
      "Summarize the key points",
    );
  });

  it("defaults to article layout (no timestamps, words still seek) and the timeline toggle reveals timestamps", async () => {
    const seekSpy = vi
      .spyOn(WaveformPlayer.prototype, "seekTo")
      .mockImplementation(() => {});
    const runs = [
      run({
        id: "t1",
        kind: "transcribe",
        status: "done",
        result: {
          segments: [
            {
              text: "ab",
              start: 1,
              end: 4,
              words: [
                { word: "a", start: 1, end: 2 },
                { word: "b", start: 2, end: 4 },
              ],
            },
          ],
        },
      }),
    ];
    await renderDetail(container, "i", {
      loadRuns: async () => runs,
      loadAudio: async () => new Blob(["x"]),
    });

    const snap = container.querySelector<HTMLElement>(".run-snapshot")!;
    // Article default: no per-segment timestamp shown...
    expect(snap.classList.contains("timeline")).toBe(false);
    expect(snap.querySelector(".turn .t")).toBeNull();
    // ...but words are still click-to-seek.
    container.querySelectorAll<HTMLElement>(".segment-word")[0].click();
    expect(seekSpy).toHaveBeenCalledWith(1);

    // Toggle timeline → per-segment timestamps appear.
    container.querySelector<HTMLButtonElement>(".timeline-toggle")!.click();
    expect(snap.classList.contains("timeline")).toBe(true);
    expect(snap.querySelector(".turn .t")).not.toBeNull();
    seekSpy.mockRestore();
  });
});
