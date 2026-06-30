/**
 * Home recording layer (fe-home-redesign, task 1.2).
 *
 * Replaces the two ModeCard presentations with one shared overlay that
 * renders Home's recording / paused / processing / confirming / done states.
 * Structure + classes only — CSS lands in a later task; tests assert
 * DOM/classes/attributes, never computed styles.
 *
 * State semantics mirror ModeCard (src/ui/mode-card.ts):
 *   - start() flips into `recording`, starts the timer, then calls the
 *     mode's deps.onStart(). Only one mode may be active at a time —
 *     starting while the layer is non-idle is a no-op (mutual exclusion).
 *   - The stop button calls deps.onStop() but does NOT change state;
 *     main.ts later calls showProcessing(), exactly like the legacy flow.
 *   - The pause control toggles recording⇄paused locally (accumulating
 *     elapsed ms across pauses, same approach as ModeCard) and calls
 *     deps.onPauseResume(). There is no separate togglePause() on the
 *     surface — the layer owns the pause presentation.
 *   - The discard control calls deps.onDiscard(); main.ts then reset()s.
 *   - markDone() is exposed PER-ADAPTER: main.ts calls e.g.
 *     layer.live.markDone() to transition that mode processing → done.
 *   - reset() returns to idle (clears timer/draft visibility) and fires a
 *     state change so subscribers (the shell REC pill) settle.
 *
 * Adapters keep the exact ModeCard surface consumed by main.ts —
 * setDisabled / reset / showProcessing / showConfirming / openFilePicker /
 * getState — plus start() and markDone(), so call sites swap 1:1.
 */

import { t } from "../i18n";
import { copyToClipboard } from "../platform/clipboard";
import { createLiveWaveform, type LiveWaveform } from "./live-waveform";

// Re-exported for existing importers — the implementation lives in
// platform/clipboard.ts so non-recording components can share it.
export { copyToClipboard };

export type FinalKind = "live" | "batch";

export interface FinalCue {
  text: string;
  start_ms: number;
  end_ms: number;
  kind?: FinalKind;
}

export type RecordingLayerState =
  | "idle"
  | "recording"
  | "paused"
  | "processing"
  | "confirming"
  | "done";

type ModeName = "live" | "batch";

export interface RecordingModeDeps {
  onStart: () => void;
  onStop: () => void;
  onPauseResume: () => void;
  onDiscard: () => void;
}

export interface BatchModeDeps extends RecordingModeDeps {
  onFilePicked?: (file: File) => void;
  onConfirmStart?: () => void;
  onConfirmChange?: () => void;
}

export interface RecordingLayerDeps {
  live: RecordingModeDeps;
  batch: BatchModeDeps;
  /** Mirrors main.ts's "disable the other entry points" hook. */
  setEntriesDisabled: (disabled: boolean, title?: string) => void;
  /** Called when the user flips the recbar's live-captions toggle. */
  onLiveToggle?: (on: boolean) => void;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  /** Injectable live-waveform factory (fe-home-dashboard); defaults to the
   *  real AnalyserNode implementation. */
  waveformFactory?: (canvas: HTMLCanvasElement) => LiveWaveform;
}

export interface RecordingModeAdapter {
  /** Flip this mode into `recording` and call its onStart(). No-op if the layer is non-idle. */
  start: () => void;
  setDisabled: (disabled: boolean, title?: string) => void;
  reset: () => void;
  /** Optional label mirrors ModeCard.showProcessing(label?) — e.g. the
   *  "confirming last segment" hint during a graceful Live stop. */
  showProcessing: (label?: string) => void;
  /** Mirrors ModeCard.showConfirming(filename, durationLabel); also accepts a File. */
  showConfirming: (file: File | string, durationLabel: string) => void;
  openFilePicker: () => void;
  getState: () => RecordingLayerState;
  /** processing → done transition, triggered by main.ts. */
  markDone: () => void;
}

export interface RecordingLayerSnapshot {
  active: boolean;
  state: RecordingLayerState;
  elapsedLabel: string;
}

export interface RecordingLayerEls {
  root: HTMLElement;
  /** main.ts re-houses the existing live transcript element here. */
  draftHost: HTMLElement;
  transcriptHost: HTMLElement;
  actionsHost: HTMLElement;
  answerHost: HTMLElement;
}

export interface RecordingLayer {
  live: RecordingModeAdapter;
  batch: RecordingModeAdapter;
  els: RecordingLayerEls;
  /** Provide/clear the open-item navigation; the button renders only while set. */
  setDoneAction: (fn: (() => void) | null) => void;
  /** Provide/clear the done-view (re-)transcribe action; the button renders
   *  only while set. `label` lets the caller switch between "Transcribe"
   *  (no live transcript yet) and "Re-transcribe (higher quality)". */
  setReTranscribeAction: (fn: (() => void) | null, label?: string) => void;
  /** Configure the recbar live-captions toggle: availability, checked state,
   *  and an optional hint (tooltip) explaining the current strategy. */
  setLiveToggle: (opts: {
    available: boolean;
    on: boolean;
    hint?: string;
  }) => void;
  /** Feed the live mic stream to the recbar waveform; no-op unless the layer
   *  is recording or paused. The layer stops the waveform itself when the
   *  capture leaves those states. */
  startWaveform: (stream: MediaStream) => void;
  /** Append a confirmed final cue to the owned live transcript. */
  appendFinal: (cue: FinalCue) => void;
  /** Replace the in-flight partial line (empty string clears it). */
  setPartial: (text: string) => void;
  /** The current in-flight partial text ("" when none is showing). */
  getPartial: () => string;
  /** Clear the in-flight partial line. */
  clearPartial: () => void;
  /** Clear all finals and the partial. */
  clear: () => void;
  /** Plain-text join of the current finals (newline-separated). */
  getText: () => string;
  /** Scroll the transcript to its latest line (caller gates on the setting). */
  scrollTranscriptToEnd: () => void;
  subscribe: (cb: (s: RecordingLayerSnapshot) => void) => () => void;
  destroy: () => void;
}

export function formatElapsedLabel(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function button(className: string, label: string): HTMLButtonElement {
  const b = el("button", className);
  b.type = "button";
  b.textContent = label;
  return b;
}

function formatMmSs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

interface OwnedTranscript {
  el: HTMLElement;
  appendFinal: (cue: FinalCue) => void;
  setPartial: (text: string) => void;
  getPartial: () => string;
  clearPartial: () => void;
  clear: () => void;
  getText: () => string;
}

/**
 * The live transcript the recording layer owns (1:1 port of the retired v2
 * TranscriptView). Renders a header (title + copy), an append-only list of
 * confirmed final cues, a greyed partial slot, and an empty-state placeholder.
 * Reuses the `.transcript-view` CSS contract so styling is unchanged.
 */
function createTranscript(): OwnedTranscript {
  const root = el("div", "transcript-view");

  const header = el("div", "transcript-header");
  const titleEl = el("span", "transcript-title");
  titleEl.textContent = t("transcript.title");
  const copyBtn = button("transcript-copy", t("common.copy"));
  copyBtn.title = t("transcript.copyTitle");
  copyBtn.addEventListener("click", () => {
    void copyToClipboard(getText()).then((ok) => {
      copyBtn.textContent = ok ? t("transcript.copied") : t("transcript.copyFailed");
      setTimeout(() => (copyBtn.textContent = t("common.copy")), 1500);
    });
  });
  header.append(titleEl, copyBtn);

  // Empty-state hint; hidden whenever there is at least one final OR a partial.
  const placeholderEl = el("div", "transcript-placeholder");
  placeholderEl.textContent = t("transcript.placeholder");

  const finalsEl = el("div", "transcript-finals");
  const partialEl = el("div", "transcript-partial");
  root.append(header, placeholderEl, finalsEl, partialEl);

  function updatePlaceholder(): void {
    placeholderEl.hidden =
      finalsEl.childElementCount > 0 || (partialEl.textContent ?? "").length > 0;
  }
  function getText(): string {
    return [...finalsEl.querySelectorAll(".transcript-text")]
      .map((n) => n.textContent ?? "")
      .join("\n");
  }
  function setPartial(text: string): void {
    partialEl.textContent = text;
    partialEl.classList.toggle("is-active", text.length > 0);
    updatePlaceholder();
  }
  function clearPartial(): void {
    setPartial("");
  }
  function appendFinal(cue: FinalCue): void {
    const row = el("div", "transcript-final");
    const kind: FinalKind = cue.kind ?? "live";
    row.dataset.kind = kind;
    if (kind === "live") {
      const ts = el("span", "transcript-ts");
      ts.textContent = formatMmSs(cue.start_ms);
      row.appendChild(ts);
    }
    const text = el("span", "transcript-text");
    text.textContent = cue.text;
    row.appendChild(text);
    finalsEl.appendChild(row);
    // Finals own the confirmed history; the partial slot only shows the
    // current in-flight utterance.
    clearPartial();
    updatePlaceholder();
  }
  function clear(): void {
    finalsEl.replaceChildren();
    clearPartial();
    updatePlaceholder();
  }

  updatePlaceholder();
  return {
    el: root,
    appendFinal,
    setPartial,
    getPartial: () => partialEl.textContent ?? "",
    clearPartial,
    clear,
    getText,
  };
}

export function createRecordingLayer(
  container: HTMLElement,
  deps: RecordingLayerDeps,
): RecordingLayer {
  const now = deps.now ?? Date.now;

  let state: RecordingLayerState = "idle";
  let activeMode: ModeName | null = null;
  /** Accumulated active ms across pauses; the live segment is timer-driven. */
  let accumulatedMs = 0;
  let originMs = 0;
  let elapsedLabel = formatElapsedLabel(0);
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let doneAction: (() => void) | null = null;
  const disabledModes: Record<ModeName, boolean> = { live: false, batch: false };
  const subscribers = new Set<(s: RecordingLayerSnapshot) => void>();

  // ----- DOM ---------------------------------------------------------------
  const root = el("div", "recording-layer");
  root.hidden = true;
  root.dataset.state = "idle";

  // recbar: blinking dot, elapsed <time>, pause/resume, discard, stop
  const recbar = el("div", "recbar");
  const recdot = el("span", "recdot");
  const waveformCanvas = el("canvas", "rec-waveform");
  const waveform = (deps.waveformFactory ?? createLiveWaveform)(
    waveformCanvas,
  );
  const timeEl = el("time", "rec-elapsed mono");
  timeEl.textContent = elapsedLabel;
  const pauseBtn = button("icon-button pause-btn", "⏸");
  pauseBtn.title = t("modeCard.pause");
  pauseBtn.setAttribute("aria-label", t("modeCard.pause"));
  const discardBtn = button("icon-button discard-btn", "✕");
  discardBtn.title = t("modeCard.discard");
  discardBtn.setAttribute("aria-label", t("modeCard.discard"));
  const stopBtn = button("stopbtn", `⏹ ${t("rec.stop")}`);
  // Live-captions toggle: flips the live caption sink on/off mid-recording
  // (no backfill). main.ts owns the sink; the layer only surfaces the control.
  const liveToggleWrap = el("label", "live-toggle");
  const liveToggleInput = document.createElement("input");
  liveToggleInput.type = "checkbox";
  liveToggleInput.className = "live-toggle-input";
  const liveToggleText = el("span", "live-toggle-label");
  liveToggleText.textContent = t("rec.liveCaptions");
  liveToggleWrap.append(liveToggleInput, liveToggleText);
  liveToggleInput.addEventListener("change", () => {
    deps.onLiveToggle?.(liveToggleInput.checked);
  });
  recbar.append(
    recdot,
    waveformCanvas,
    timeEl,
    liveToggleWrap,
    pauseBtn,
    discardBtn,
    stopBtn,
  );

  // draft: labelled host for the live transcript element
  const draft = el("div", "draft");
  const draftLabel = el("div", "draft-label");
  draftLabel.textContent = t("rec.liveDraft");
  const draftHost = el("div", "draft-host");
  draft.append(draftLabel, draftHost);

  // processing indicator
  const processing = el("div", "processing");
  const spinner = el("span", "spinner");
  const processingLabel = el("span", "processing-label");
  processingLabel.textContent = t("modeCard.processing");
  processing.append(spinner, processingLabel);

  // confirming (file pre-upload)
  const confirmRow = el("div", "confirm-row");
  const confirmName = el("span", "confirm-filename");
  const confirmSep = el("span", "confirm-sep");
  confirmSep.textContent = " · ";
  const confirmDur = el("span", "confirm-duration");
  const confirmChangeBtn = button(
    "btn-secondary confirm-change",
    t("modeCard.confirmChange"),
  );
  const confirmStartBtn = button(
    "btn-primary confirm-start",
    t("modeCard.confirmStart"),
  );
  confirmRow.append(
    confirmName,
    confirmSep,
    confirmDur,
    confirmChangeBtn,
    confirmStartBtn,
  );

  // done layout: title + close (back to the hero) + re-housing hosts +
  // (conditional) open-item
  const doneLayout = el("div", "done-layout");
  const doneHeader = el("div", "done-header");
  const doneTitle = document.createElement("h3");
  doneTitle.textContent = t("rec.doneTitle");
  const doneCloseBtn = button("done-close", "✕");
  doneCloseBtn.title = t("common.close");
  doneCloseBtn.setAttribute("aria-label", t("common.close"));
  doneHeader.append(doneTitle, doneCloseBtn);
  const transcriptHost = el("div", "transcript-host");
  const actionsHost = el("div", "actions-host");
  const answerHost = el("div", "answer-host");
  doneLayout.append(doneHeader, transcriptHost, actionsHost, answerHost);
  const openItemBtn = button("open-item", t("rec.openItem"));
  // Opt-in (re-)transcription over the recorded blob, offered on the done view.
  const reTranscribeBtn = button("re-transcribe", t("rec.reTranscribe"));

  // hidden file input (batch upload)
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "audio/*";
  fileInput.hidden = true;

  root.append(recbar, draft, processing, confirmRow, doneLayout, fileInput);
  container.appendChild(root);

  // The layer owns the live transcript: it renders into the draft host while
  // capturing and moves into the done-layout host when the capture lands, so
  // main.ts no longer re-houses a standalone surface by state.
  const transcript = createTranscript();
  draftHost.appendChild(transcript.el);

  // ----- state machine -----------------------------------------------------
  function emit(): void {
    const snapshot: RecordingLayerSnapshot = {
      active: state === "recording" || state === "paused",
      state,
      elapsedLabel,
    };
    for (const cb of subscribers) cb(snapshot);
  }

  function applyState(): void {
    root.hidden = state === "idle";
    root.dataset.state = state;
    if (activeMode) root.dataset.mode = activeMode;
    else delete root.dataset.mode;

    const capturing = state === "recording" || state === "paused";
    recbar.hidden = !capturing;
    draft.hidden = !capturing;
    processing.hidden = state !== "processing";
    confirmRow.hidden = state !== "confirming";
    doneLayout.hidden = state !== "done";

    // Re-house the owned transcript: draft host while capturing, done-layout
    // host once the capture lands (mirrors the retired main.ts panePlacement).
    if (capturing && transcript.el.parentElement !== draftHost) {
      draftHost.appendChild(transcript.el);
    } else if (state === "done" && transcript.el.parentElement !== transcriptHost) {
      transcriptHost.appendChild(transcript.el);
    }

    // Pause is a batch-only affordance (same as the legacy cards).
    pauseBtn.hidden = activeMode !== "batch";
    if (state === "paused") {
      pauseBtn.textContent = "▶";
      pauseBtn.title = t("modeCard.resume");
      pauseBtn.setAttribute("aria-label", t("modeCard.resume"));
    } else {
      pauseBtn.textContent = "⏸";
      pauseBtn.title = t("modeCard.pause");
      pauseBtn.setAttribute("aria-label", t("modeCard.pause"));
    }
  }

  function setState(next: RecordingLayerState): void {
    const wasCapturing = state === "recording" || state === "paused";
    state = next;
    const isCapturing = state === "recording" || state === "paused";
    // The waveform lives only while capturing — leaving recording/paused
    // (processing, done, idle, confirming) releases its audio resources.
    if (wasCapturing && !isCapturing) waveform.stop();
    applyState();
    emit();
  }

  function setElapsed(ms: number): void {
    elapsedLabel = formatElapsedLabel(ms);
    timeEl.textContent = elapsedLabel;
    timeEl.dateTime = `PT${Math.max(0, Math.floor(ms / 1000))}S`;
  }

  function startTimer(): void {
    if (timerInterval !== null) return;
    timerInterval = setInterval(() => {
      setElapsed(accumulatedMs + (now() - originMs));
      emit();
    }, 250);
  }

  function stopTimer(): void {
    if (timerInterval !== null) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function applyDisabled(): void {
    root.classList.toggle(
      "is-disabled",
      disabledModes.live || disabledModes.batch,
    );
    // The confirm/upload controls belong to the batch mode only — the legacy
    // flow disables the LIVE card while a batch upload is pending, and that
    // must not lock the batch confirm row itself.
    confirmStartBtn.disabled = disabledModes.batch;
    confirmChangeBtn.disabled = disabledModes.batch;
    fileInput.disabled = disabledModes.batch;
  }

  // ----- wiring ------------------------------------------------------------
  stopBtn.addEventListener("click", () => {
    if (!activeMode || (state !== "recording" && state !== "paused")) return;
    // State stays put — main.ts calls showProcessing() after onStop, exactly
    // like the legacy ModeCard flow.
    deps[activeMode].onStop();
  });

  pauseBtn.addEventListener("click", () => {
    if (!activeMode) return;
    if (state === "recording") {
      accumulatedMs += now() - originMs;
      stopTimer();
      setElapsed(accumulatedMs);
      setState("paused");
    } else if (state === "paused") {
      originMs = now();
      startTimer();
      setState("recording");
    } else {
      return;
    }
    deps[activeMode].onPauseResume();
  });

  discardBtn.addEventListener("click", () => {
    if (!activeMode || (state !== "recording" && state !== "paused")) return;
    deps[activeMode].onDiscard();
  });

  confirmStartBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    deps.batch.onConfirmStart?.();
  });
  confirmChangeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    deps.batch.onConfirmChange?.();
  });

  openItemBtn.addEventListener("click", () => {
    doneAction?.();
  });

  let reTranscribeAction: (() => void) | null = null;
  reTranscribeBtn.addEventListener("click", () => {
    reTranscribeAction?.();
  });

  // Done is a resting state with no other exit — ✕ returns Home to the hero
  // (the subscriber in main.ts re-houses the panes on the idle emit).
  doneCloseBtn.addEventListener("click", () => {
    if (state !== "done") return;
    activeMode = null;
    stopTimer();
    accumulatedMs = 0;
    setElapsed(0);
    fileInput.value = "";
    setState("idle");
  });

  fileInput.addEventListener("change", (e) => {
    e.stopPropagation();
    const file = fileInput.files?.[0];
    if (!file) return;
    deps.batch.onFilePicked?.(file);
  });
  // Programmatic .click() on the input must never bubble into ancestors that
  // treat a body click as "start" (same trap ModeCard documents).
  fileInput.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // ----- adapters ----------------------------------------------------------
  function makeAdapter(mode: ModeName): RecordingModeAdapter {
    return {
      start(): void {
        // Mutual exclusion: only one mode at a time. `done` counts as
        // startable — a new capture replaces the finished one's view.
        if ((state !== "idle" && state !== "done") || disabledModes[mode]) {
          return;
        }
        activeMode = mode;
        accumulatedMs = 0;
        originMs = now();
        setElapsed(0);
        startTimer();
        setState("recording");
        deps[mode].onStart();
      },

      setDisabled(disabled: boolean, title?: string): void {
        deps.setEntriesDisabled(disabled, title);
        disabledModes[mode] = disabled;
        applyDisabled();
      },

      reset(): void {
        // Resetting the inactive mode is a no-op — it is already idle.
        if (activeMode !== null && activeMode !== mode) return;
        activeMode = null;
        stopTimer();
        accumulatedMs = 0;
        setElapsed(0);
        // Clear the value so re-picking the SAME file re-fires `change`.
        fileInput.value = "";
        setState("idle");
      },

      showProcessing(label?: string): void {
        activeMode = mode;
        stopTimer();
        processingLabel.textContent = label ?? t("modeCard.processing");
        setState("processing");
      },

      showConfirming(file: File | string, durationLabel: string): void {
        activeMode = mode;
        stopTimer();
        confirmName.textContent = typeof file === "string" ? file : file.name;
        confirmDur.textContent = durationLabel;
        setState("confirming");
      },

      openFilePicker(): void {
        fileInput.value = "";
        fileInput.click();
      },

      getState(): RecordingLayerState {
        return activeMode === mode ? state : "idle";
      },

      markDone(): void {
        if (activeMode !== mode || state !== "processing") return;
        setState("done");
      },
    };
  }

  function setReTranscribeAction(
    fn: (() => void) | null,
    label?: string,
  ): void {
    reTranscribeAction = fn;
    if (fn) {
      if (label) reTranscribeBtn.textContent = label;
      if (!reTranscribeBtn.isConnected) doneLayout.appendChild(reTranscribeBtn);
    } else {
      reTranscribeBtn.remove();
    }
  }

  function setLiveToggle(opts: {
    available: boolean;
    on: boolean;
    hint?: string;
  }): void {
    liveToggleInput.disabled = !opts.available;
    liveToggleInput.checked = opts.on;
    liveToggleWrap.title = opts.hint ?? "";
    liveToggleWrap.classList.toggle("is-disabled", !opts.available);
  }

  function setDoneAction(fn: (() => void) | null): void {
    doneAction = fn;
    if (fn) {
      if (!openItemBtn.isConnected) doneLayout.appendChild(openItemBtn);
    } else {
      openItemBtn.remove();
    }
  }

  function subscribe(cb: (s: RecordingLayerSnapshot) => void): () => void {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }

  function startWaveform(stream: MediaStream): void {
    if (state !== "recording" && state !== "paused") return;
    waveform.start(stream);
  }

  function destroy(): void {
    stopTimer();
    waveform.stop();
    subscribers.clear();
    root.remove();
  }

  return {
    live: makeAdapter("live"),
    batch: makeAdapter("batch"),
    els: { root, draftHost, transcriptHost, actionsHost, answerHost },
    setDoneAction,
    setReTranscribeAction,
    setLiveToggle,
    startWaveform,
    appendFinal: transcript.appendFinal,
    setPartial: transcript.setPartial,
    getPartial: transcript.getPartial,
    clearPartial: transcript.clearPartial,
    clear: transcript.clear,
    getText: transcript.getText,
    scrollTranscriptToEnd: () => {
      transcript.el.scrollTop = transcript.el.scrollHeight;
    },
    subscribe,
    destroy,
  };
}
