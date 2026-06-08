/**
 * Meeting Mode page wiring.
 *
 * Composes: upload zone → confirm card (filename + duration + Start) →
 * 4-step stepper with per-stage progress + elapsed/estimated remaining →
 * speaker-coloured transcript + click-to-seek + speaker-aware exports →
 * Recent analyses sidebar (localStorage). Stop button is available while
 * the pipeline runs (best-effort: fires DELETE; UI resets either way).
 *
 * Stage timing model: each stage has its own 0-100% progress bar computed
 * from elapsed time vs an audio-length-derived estimate (purely client-side
 * — backend just emits the discrete stage transitions). The estimate caps
 * at 95% so the bar doesn't show "100%" while still running.
 */

import { exportSpeakerSrt } from "../export/speaker-srt";
import { exportSpeakerTxt } from "../export/speaker-txt";
import { exportSpeakerVtt } from "../export/speaker-vtt";
import {
  loadHistory,
  recordHistory,
  removeHistory,
  updateHistory,
  type HistoryEntry,
} from "./history-store";
import {
  cancelMeeting,
  fetchJobStatus,
  pollUntilDone,
  submitMeeting,
} from "./meeting-api";
import { speakerColorMap } from "./speaker-colors";
import type { JobStatusResponse, MeetingResult, Segment } from "./types";

export interface StatusInfo {
  available: boolean;
  reason?: string;
}

export interface MeetingPageHandle {
  element: HTMLElement;
  /** For tests: render a transcript without going through the network. */
  renderResult(result: MeetingResult, objectUrl: string): void;
}

export interface MeetingPageOptions {
  /** Override fetch (for tests). */
  fetchFn?: typeof fetch;
  /** Override URL.createObjectURL (for tests with happy-dom). */
  createObjectURL?: (file: File | Blob) => string;
  /** Override status fetch (returns availability shape). */
  fetchStatus?: () => Promise<StatusInfo>;
  /** Polling interval for status updates (default 2 s; tests can lower it). */
  pollIntervalMs?: number;
  /** Override Date.now (for tests). */
  now?: () => number;
}

// --- Stage model -------------------------------------------------------------

type StageKey = "upload" | "asr" | "align" | "diarize";
interface StageDef {
  key: StageKey;
  label: string;
  /** Default hint shown when this stage is pending or complete. */
  defaultHint: string;
  /** Fraction of audio_duration to estimate this stage's wall-clock duration.
   *  Values calibrated against macOS CPU baseline; GPU finishes faster but
   *  estimates will then over-shoot, which the 95% cap smooths over. */
  ratio: number;
}
const STAGES: StageDef[] = [
  { key: "upload", label: "Upload", defaultHint: "send file", ratio: 0 },
  { key: "asr", label: "Transcribe", defaultHint: "speech → text", ratio: 0.05 },
  { key: "align", label: "Align", defaultHint: "word timing", ratio: 0.1 },
  { key: "diarize", label: "Diarize", defaultHint: "who spoke when", ratio: 0.2 },
];
type StepState = "pending" | "active" | "complete";

const SPINNER_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 28">' +
  '<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/>' +
  "</circle></svg>";

// --- Page factory ------------------------------------------------------------

export function createMeetingPage(
  opts: MeetingPageOptions = {},
): MeetingPageHandle {
  const root = document.createElement("section");
  root.className = "meeting-page";

  const now = opts.now ?? (() => Date.now());

  // ------ DOM ---------------------------------------------------------------
  const layout = document.createElement("div");
  layout.className = "meeting-layout";

  const mainCol = document.createElement("div");
  mainCol.className = "meeting-main";

  const header = document.createElement("header");
  header.className = "meeting-header";
  const h1 = document.createElement("h1");
  h1.textContent = "Meeting Mode";
  const subtitle = document.createElement("p");
  subtitle.className = "meeting-subtitle";
  subtitle.textContent =
    "Upload a meeting recording to get speaker-labelled transcripts with word-level timestamps.";
  header.append(h1, subtitle);

  const unavailableEl = document.createElement("div");
  unavailableEl.className = "meeting-unavailable";
  unavailableEl.hidden = true;

  const audioEl = document.createElement("audio");
  audioEl.className = "meeting-audio";
  audioEl.controls = true;
  audioEl.preload = "metadata";

  // Initial state: drop-zone upload area inviting a file pick.
  const uploadForm = document.createElement("form");
  uploadForm.className = "meeting-upload";
  const uploadLabel = document.createElement("label");
  uploadLabel.className = "upload-zone";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "audio/*";
  const uploadIcon = document.createElement("span");
  uploadIcon.className = "upload-icon";
  uploadIcon.setAttribute("aria-hidden", "true");
  uploadIcon.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
  const uploadTitle = document.createElement("span");
  uploadTitle.className = "upload-title";
  uploadTitle.textContent = "Choose audio file or drop here";
  const uploadHint = document.createElement("span");
  uploadHint.className = "upload-hint";
  uploadHint.textContent = "WAV, MP3, M4A, FLAC, OGG — up to 100 MB";
  uploadLabel.append(fileInput, uploadIcon, uploadTitle, uploadHint);
  uploadForm.append(uploadLabel);

  // Confirm card: shown after file pick, before upload starts. Hidden in
  // initial state and during pipeline run.
  const confirmCard = document.createElement("div");
  confirmCard.className = "meeting-confirm";
  confirmCard.hidden = true;
  const confirmInfo = document.createElement("div");
  confirmInfo.className = "confirm-info";
  const confirmName = document.createElement("div");
  confirmName.className = "confirm-name";
  const confirmMeta = document.createElement("div");
  confirmMeta.className = "confirm-meta";
  confirmInfo.append(confirmName, confirmMeta);
  const confirmActions = document.createElement("div");
  confirmActions.className = "confirm-actions";
  const changeBtn = document.createElement("button");
  changeBtn.type = "button";
  changeBtn.className = "btn-secondary";
  changeBtn.textContent = "Change file";
  const startBtn = document.createElement("button");
  startBtn.type = "button";
  startBtn.className = "btn-primary";
  startBtn.textContent = "Start analysis";
  confirmActions.append(changeBtn, startBtn);
  confirmCard.append(confirmInfo, confirmActions);

  // Stepper.
  const stepperEl = document.createElement("div");
  stepperEl.className = "meeting-stepper";
  stepperEl.hidden = true;
  const stepEls = new Map<StageKey, HTMLElement>();
  const stepHints = new Map<StageKey, HTMLElement>();
  const stepMarkers = new Map<StageKey, HTMLElement>();
  const stepFills = new Map<StageKey, HTMLElement>();
  STAGES.forEach(({ key, label, defaultHint }, idx) => {
    const step = document.createElement("div");
    step.className = "step";
    step.dataset.stage = key;
    step.dataset.state = "pending";
    const marker = document.createElement("span");
    marker.className = "step-marker";
    marker.textContent = String(idx + 1);
    const labelEl = document.createElement("span");
    labelEl.className = "step-label";
    labelEl.textContent = label;
    const bar = document.createElement("div");
    bar.className = "step-bar";
    const fill = document.createElement("div");
    fill.className = "step-bar-fill";
    bar.appendChild(fill);
    const hintEl = document.createElement("span");
    hintEl.className = "step-hint";
    hintEl.textContent = defaultHint;
    step.append(marker, labelEl, bar, hintEl);
    stepperEl.appendChild(step);
    stepEls.set(key, step);
    stepHints.set(key, hintEl);
    stepMarkers.set(key, marker);
    stepFills.set(key, fill);
  });

  // Stop button — visible only during stepper run.
  const stopRow = document.createElement("div");
  stopRow.className = "meeting-stop-row";
  stopRow.hidden = true;
  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "btn-danger";
  stopBtn.textContent = "Stop analysis";
  stopRow.appendChild(stopBtn);

  const errorEl = document.createElement("div");
  errorEl.className = "meeting-error";
  errorEl.hidden = true;

  const transcriptEl = document.createElement("div");
  transcriptEl.className = "meeting-transcript";

  const exportsEl = document.createElement("footer");
  exportsEl.className = "meeting-exports";
  exportsEl.hidden = true;
  for (const fmt of ["srt", "vtt", "txt"] as const) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.export = fmt;
    btn.textContent = `Download ${fmt.toUpperCase()}`;
    exportsEl.appendChild(btn);
  }
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "meeting-reset btn-secondary";
  resetBtn.textContent = "Analyze another file";
  exportsEl.appendChild(resetBtn);

  mainCol.append(
    header,
    unavailableEl,
    audioEl,
    uploadForm,
    confirmCard,
    stepperEl,
    stopRow,
    errorEl,
    transcriptEl,
    exportsEl,
  );

  // Sidebar — Recent analyses (localStorage)
  const sideCol = document.createElement("aside");
  sideCol.className = "meeting-sidebar";
  const sideHeader = document.createElement("div");
  sideHeader.className = "sidebar-header";
  const sideTitle = document.createElement("h2");
  sideTitle.textContent = "Recent analyses";
  sideHeader.appendChild(sideTitle);
  const sideList = document.createElement("ul");
  sideList.className = "sidebar-list";
  const sideEmpty = document.createElement("p");
  sideEmpty.className = "sidebar-empty";
  sideEmpty.textContent = "No analyses yet — upload a file to get started.";
  sideCol.append(sideHeader, sideEmpty, sideList);

  layout.append(mainCol, sideCol);
  root.append(layout);

  // ------ State -------------------------------------------------------------

  const fetchFn = opts.fetchFn ?? fetch;
  const defaultCreateObjectURL: (file: File | Blob) => string =
    typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL.bind(URL)
      : () => "";
  const createObjectURL = opts.createObjectURL ?? defaultCreateObjectURL;
  const fetchStatus =
    opts.fetchStatus ??
    (async () => {
      const resp = await fetchFn("/status");
      const body = await resp.json();
      const m = body?.meeting ?? {};
      const reason = m.available
        ? undefined
        : m.hf_token_configured === false
          ? "HF_TOKEN is not configured"
          : m.extras_installed === false
            ? "meeting extras not installed"
            : "Meeting analysis is unavailable.";
      return { available: !!m.available, reason };
    });

  let lastResult: MeetingResult | null = null;
  let lastObjectUrl: string | null = null;
  let selectedFile: File | null = null;
  let audioDurationSeconds: number | null = null;
  let activeJobId: string | null = null;
  let abortController: AbortController | null = null;
  // Per-stage start timestamps for elapsed/remaining calculation.
  const stageStartedAt = new Map<StageKey, number>();
  let tickHandle: ReturnType<typeof setInterval> | null = null;

  // ------ Helpers ----------------------------------------------------------

  function showError(message: string) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }
  function clearError() {
    errorEl.textContent = "";
    errorEl.hidden = true;
  }

  function setMarker(stage: StageKey, state: StepState, idx: number) {
    const marker = stepMarkers.get(stage);
    if (!marker) return;
    if (state === "complete") {
      marker.textContent = "✓";
    } else if (state === "active") {
      // Spinner SVG replaces the numeric marker so "running" is unmistakable.
      marker.innerHTML = SPINNER_SVG;
    } else {
      marker.textContent = String(idx + 1);
    }
  }

  function setStepState(stage: StageKey, state: StepState) {
    const el = stepEls.get(stage);
    if (!el) return;
    el.dataset.state = state;
    const idx = STAGES.findIndex((s) => s.key === stage);
    setMarker(stage, state, idx);
    const fill = stepFills.get(stage);
    if (fill) {
      if (state === "complete") fill.style.width = "100%";
      else if (state === "pending") fill.style.width = "0%";
      // active: width updated by tickStage()
    }
    if (state === "complete") {
      // Reset hint so a stale "running…" line doesn't linger under the ✓.
      const defaultHint = STAGES[idx]?.defaultHint ?? "";
      const el = stepHints.get(stage);
      if (el) el.textContent = state === "complete" ? "done" : defaultHint;
    }
  }

  function resetStepper(): void {
    stepperEl.hidden = true;
    stopRow.hidden = true;
    stageStartedAt.clear();
    if (tickHandle !== null) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
    STAGES.forEach((s, i) => {
      setStepState(s.key, "pending");
      const marker = stepMarkers.get(s.key);
      if (marker) marker.textContent = String(i + 1);
      const hint = stepHints.get(s.key);
      if (hint) hint.textContent = s.defaultHint;
      const fill = stepFills.get(s.key);
      if (fill) fill.style.width = "0%";
    });
  }

  function activateStage(stage: StageKey) {
    stepperEl.hidden = false;
    stopRow.hidden = false;
    const idx = STAGES.findIndex((s) => s.key === stage);
    if (idx < 0) return;
    // Mark all prior stages complete (handles align-skipped case).
    for (let i = 0; i < idx; i++) {
      setStepState(STAGES[i].key, "complete");
    }
    setStepState(stage, "active");
    if (!stageStartedAt.has(stage)) stageStartedAt.set(stage, now());
    // Start the per-second ticker if not running.
    if (tickHandle === null) {
      tickHandle = setInterval(() => tickActiveStage(), 1000);
    }
    tickActiveStage();
  }

  function tickActiveStage(): void {
    // Find the currently active stage and update its progress bar + hint.
    const activeIdx = STAGES.findIndex(
      (s) => stepEls.get(s.key)?.dataset.state === "active",
    );
    if (activeIdx < 0) return;
    const stage = STAGES[activeIdx];
    const startedAt = stageStartedAt.get(stage.key);
    if (!startedAt) return;
    const elapsedMs = now() - startedAt;
    const elapsedSec = Math.floor(elapsedMs / 1000);

    // For upload stage there's no audio-derived estimate — just show elapsed.
    if (stage.key === "upload") {
      const hint = stepHints.get(stage.key);
      if (hint) hint.textContent = `sending ${formatDuration(elapsedSec)}…`;
      const fill = stepFills.get(stage.key);
      if (fill) {
        // Animate fill to look alive even without a known total.
        const pct = Math.min(85, 30 + ((elapsedSec * 8) % 56));
        fill.style.width = `${pct}%`;
      }
      return;
    }

    if (audioDurationSeconds == null || audioDurationSeconds <= 0) {
      // No audio metadata → can't estimate. Show elapsed only.
      const hint = stepHints.get(stage.key);
      if (hint) hint.textContent = `${formatDuration(elapsedSec)} elapsed`;
      return;
    }

    const estimatedSec = audioDurationSeconds * stage.ratio;
    const pct = Math.min(95, (elapsedMs / 1000 / estimatedSec) * 100);
    const fill = stepFills.get(stage.key);
    if (fill) fill.style.width = `${pct.toFixed(0)}%`;
    const remainingSec = Math.max(0, estimatedSec - elapsedMs / 1000);
    const hint = stepHints.get(stage.key);
    if (hint) {
      hint.textContent =
        remainingSec > 5
          ? `${formatDuration(elapsedSec)} · ~${formatDuration(Math.ceil(remainingSec))} left`
          : `${formatDuration(elapsedSec)} elapsed`;
    }
  }

  function completeAll(): void {
    if (tickHandle !== null) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
    STAGES.forEach((s) => setStepState(s.key, "complete"));
    stopRow.hidden = true;
  }

  // ------ Confirm card ------------------------------------------------------

  function showConfirm(file: File) {
    selectedFile = file;
    confirmName.textContent = file.name;
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    confirmMeta.textContent = `${sizeMB} MB · reading duration…`;
    confirmCard.hidden = false;
    uploadForm.hidden = true;
    audioDurationSeconds = null;
    // Probe duration by setting <audio src>. We hide the player until results
    // are in, so this is a metadata-only probe.
    const probeUrl = createObjectURL(file);
    audioEl.src = probeUrl;
    const onMeta = () => {
      audioEl.removeEventListener("loadedmetadata", onMeta);
      if (Number.isFinite(audioEl.duration)) {
        audioDurationSeconds = audioEl.duration;
        confirmMeta.textContent = `${sizeMB} MB · ${formatDuration(Math.round(audioEl.duration))}`;
      } else {
        confirmMeta.textContent = `${sizeMB} MB`;
      }
    };
    audioEl.addEventListener("loadedmetadata", onMeta);
    // Remember the probe URL so we can release it if the user cancels.
    lastObjectUrl = probeUrl;
  }

  function hideConfirm() {
    confirmCard.hidden = true;
  }

  changeBtn.addEventListener("click", () => {
    hideConfirm();
    if (lastObjectUrl) revokeObjectUrl(lastObjectUrl);
    lastObjectUrl = null;
    selectedFile = null;
    audioEl.removeAttribute("src");
    audioEl.load();
    fileInput.value = "";
    uploadForm.hidden = false;
  });

  startBtn.addEventListener("click", () => {
    if (!selectedFile) return;
    const file = selectedFile;
    hideConfirm();
    void startUpload(file);
  });

  // ------ Pipeline run ------------------------------------------------------

  async function startUpload(file: File) {
    clearError();
    transcriptEl.replaceChildren();
    exportsEl.hidden = true;
    uploadForm.hidden = true;
    audioEl.removeAttribute("src");
    resetStepper();
    activateStage("upload");
    abortController = new AbortController();
    const localAbort = abortController;

    try {
      const handle = await submitMeeting(file);
      if (localAbort.signal.aborted) {
        // User clicked Stop before the POST returned. Don't proceed; the
        // server may already be running but UI is reset.
        void cancelMeeting(handle.job_id);
        return;
      }
      activeJobId = handle.job_id;
      // Record into history immediately so a refresh during the run still
      // shows this analysis.
      recordHistory({
        job_id: handle.job_id,
        filename: file.name,
        audio_duration_seconds: audioDurationSeconds,
        started_at: now(),
        status: "running",
      });
      renderSidebar();

      const objectUrl = createObjectURL(file);
      activateStage("asr");

      const final = await pollUntilDone(
        handle.status_url,
        (status: JobStatusResponse) => {
          const stage = status.stage as StageKey | "complete" | string;
          if (stage === "complete") {
            completeAll();
            return;
          }
          if (stage === "asr" || stage === "align" || stage === "diarize") {
            activateStage(stage);
          }
        },
        opts.pollIntervalMs ?? 2000,
        localAbort.signal,
      );

      if (final.status === "cancelled") {
        // Either client-side abort or server-side cancelled — either way
        // the UI should already be reset. Just patch history.
        updateHistory(handle.job_id, { status: "cancelled" });
        renderSidebar();
        return;
      }
      if (final.status === "error") {
        showError(
          `Pipeline failed: ${final.error?.message ?? "unknown error"}`,
        );
        uploadForm.hidden = false;
        resetStepper();
        updateHistory(handle.job_id, { status: "error" });
        renderSidebar();
        return;
      }
      if (!final.result) {
        showError("Pipeline returned no result.");
        uploadForm.hidden = false;
        resetStepper();
        return;
      }
      renderResult(final.result, objectUrl);
      updateHistory(handle.job_id, {
        status: "done",
        speakers: final.result.speakers.length,
      });
      renderSidebar();
    } catch (e) {
      if (localAbort.signal.aborted) {
        // Aborted mid-fetch — silent reset, already handled below.
        return;
      }
      showError(`Upload error: ${(e as Error).message}`);
      uploadForm.hidden = false;
      resetStepper();
    }
  }

  // ------ Stop --------------------------------------------------------------

  stopBtn.addEventListener("click", () => {
    if (abortController) abortController.abort();
    if (activeJobId) void cancelMeeting(activeJobId);
    activeJobId = null;
    uploadForm.hidden = false;
    resetStepper();
    clearError();
  });

  // ------ Result rendering --------------------------------------------------

  function renderResult(result: MeetingResult, objectUrl: string) {
    lastResult = result;
    lastObjectUrl = objectUrl;
    audioEl.src = objectUrl;
    const colors = speakerColorMap(result.speakers);

    transcriptEl.replaceChildren();
    for (const seg of result.segments) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `transcript-segment speaker-${cssSafe(seg.speaker)}`;
      item.dataset.speaker = seg.speaker;
      item.dataset.start = String(seg.start);
      const speakerColor = colors.get(seg.speaker) ?? "#999";
      item.style.borderLeftColor = speakerColor;
      item.style.color = speakerColor;

      const metaEl = document.createElement("span");
      metaEl.className = "segment-meta";
      metaEl.textContent = `${seg.speaker} · ${formatTime(seg.start)}`;

      const textEl = document.createElement("span");
      textEl.className = "segment-text";
      textEl.textContent = seg.text;

      item.append(metaEl, textEl);
      item.addEventListener("click", () => seekTo(seg));
      transcriptEl.appendChild(item);
    }

    exportsEl.hidden = result.segments.length === 0;
    completeAll();
  }

  function seekTo(seg: Segment) {
    audioEl.currentTime = seg.start;
    void audioEl.play().catch(() => {
      // Autoplay block — that's fine; the user can hit play themselves.
    });
  }

  // ------ Exports + reset ---------------------------------------------------

  function downloadBlob(filename: string, contents: string, mime: string) {
    const blob = new Blob([contents], { type: mime });
    const url = createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  exportsEl
    .querySelector<HTMLButtonElement>('[data-export="srt"]')!
    .addEventListener("click", () => {
      if (!lastResult) return;
      downloadBlob(
        "meeting.srt",
        exportSpeakerSrt(lastResult.segments),
        "application/x-subrip",
      );
    });
  exportsEl
    .querySelector<HTMLButtonElement>('[data-export="vtt"]')!
    .addEventListener("click", () => {
      if (!lastResult) return;
      downloadBlob(
        "meeting.vtt",
        exportSpeakerVtt(lastResult.segments),
        "text/vtt",
      );
    });
  exportsEl
    .querySelector<HTMLButtonElement>('[data-export="txt"]')!
    .addEventListener("click", () => {
      if (!lastResult) return;
      downloadBlob(
        "meeting.txt",
        exportSpeakerTxt(lastResult.segments),
        "text/plain",
      );
    });

  function revokeObjectUrl(url: string) {
    if (typeof URL !== "undefined" && URL.revokeObjectURL) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore.
      }
    }
  }

  function resetPage() {
    lastResult = null;
    if (lastObjectUrl) revokeObjectUrl(lastObjectUrl);
    lastObjectUrl = null;
    selectedFile = null;
    activeJobId = null;
    audioDurationSeconds = null;
    transcriptEl.replaceChildren();
    exportsEl.hidden = true;
    audioEl.removeAttribute("src");
    audioEl.load();
    resetStepper();
    clearError();
    confirmCard.hidden = true;
    uploadForm.hidden = false;
    fileInput.value = "";
  }
  resetBtn.addEventListener("click", resetPage);

  // ------ File input + drag-and-drop ---------------------------------------

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    showConfirm(file);
  });

  uploadLabel.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadLabel.classList.add("is-dragging");
  });
  uploadLabel.addEventListener("dragleave", () => {
    uploadLabel.classList.remove("is-dragging");
  });
  uploadLabel.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadLabel.classList.remove("is-dragging");
    const file = e.dataTransfer?.files?.[0];
    if (file) showConfirm(file);
  });

  // ------ Sidebar history --------------------------------------------------

  function renderSidebar(): void {
    const entries = loadHistory();
    sideList.replaceChildren();
    if (entries.length === 0) {
      sideEmpty.hidden = false;
      sideList.hidden = true;
      return;
    }
    sideEmpty.hidden = true;
    sideList.hidden = false;
    for (const entry of entries) {
      sideList.appendChild(renderHistoryItem(entry));
    }
  }

  function renderHistoryItem(entry: HistoryEntry): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "sidebar-item";
    item.dataset.status = entry.status ?? "running";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sidebar-item-btn";
    const name = document.createElement("div");
    name.className = "sidebar-item-name";
    name.textContent = entry.filename;
    const meta = document.createElement("div");
    meta.className = "sidebar-item-meta";
    const ago = formatRelativeTime(entry.started_at, now());
    const dur =
      entry.audio_duration_seconds != null
        ? formatDuration(Math.round(entry.audio_duration_seconds))
        : "—";
    const speakerStr = entry.speakers != null ? ` · ${entry.speakers}👥` : "";
    const statusStr = entry.status && entry.status !== "done" ? ` · ${entry.status}` : "";
    meta.textContent = `${ago} · ${dur}${speakerStr}${statusStr}`;
    btn.append(name, meta);
    btn.addEventListener("click", () => void loadFromHistory(entry));
    item.appendChild(btn);
    return item;
  }

  async function loadFromHistory(entry: HistoryEntry): Promise<void> {
    clearError();
    try {
      const status = await fetchJobStatus(`/transcribe/meeting/${entry.job_id}`);
      if (status.status === "done" && status.result) {
        // No audio URL — we don't have the original file anymore. Click-to-
        // seek will still work as time updates on the <audio>, but only if
        // the user later loads the same file. For v1 we render the
        // transcript without audio.
        audioEl.removeAttribute("src");
        renderResult(status.result, "");
        uploadForm.hidden = true;
        confirmCard.hidden = true;
        completeAll();
      } else if (status.status === "running" || status.status === "pending") {
        showError(
          "This job is still running. Refresh the page in a moment to see results.",
        );
      } else if (status.status === "error") {
        showError(
          `That job ended with error: ${status.error?.message ?? "unknown"}`,
        );
      } else if (status.status === "cancelled") {
        showError("That job was cancelled.");
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("404")) {
        // Server-side TTL evicted it — drop from local history too.
        removeHistory(entry.job_id);
        renderSidebar();
        showError(
          "That analysis expired (server keeps results for 1 hour). Removed from history.",
        );
      } else {
        showError(`Failed to load that analysis: ${msg}`);
      }
    }
  }

  renderSidebar();

  // ------ Availability gate ------------------------------------------------

  void fetchStatus()
    .then((info) => {
      if (!info.available) {
        unavailableEl.hidden = false;
        unavailableEl.textContent =
          info.reason ?? "Meeting analysis is unavailable.";
        fileInput.disabled = true;
        uploadLabel.classList.add("disabled");
        startBtn.disabled = true;
      }
    })
    .catch(() => {
      // If /status fails entirely, leave the page enabled — submit will
      // surface the 503 instead.
    });

  return {
    element: root,
    renderResult(result, objectUrl) {
      renderResult(result, objectUrl);
    },
  };
}

// --- Pure helpers ------------------------------------------------------------

function cssSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Human-friendly duration: "45s", "2m 13s", "1h 4m". Drops smaller units
 *  once the value crosses the next threshold so labels stay short. */
function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatRelativeTime(thenMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}
