/**
 * Meeting Mode page wiring.
 *
 * Composes: upload zone → confirm card (filename + duration + speakers
 * dropdown + language dropdown + word-timestamps toggle + Start/Change) →
 * 4-step stepper with per-stage progress + elapsed/estimated remaining →
 * speaker-coloured transcript with rename-on-hover + click-to-seek +
 * speaker-aware exports (SRT/VTT/TXT/JSON) → Recent analyses sidebar.
 *
 * All user-facing text routes through `t()` for i18n; the speaker name
 * map is per-job and persists into localStorage history.
 */

import { t, type StringKey } from "../i18n";
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
  type SubmitOptions,
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
  fetchFn?: typeof fetch;
  createObjectURL?: (file: File | Blob) => string;
  fetchStatus?: () => Promise<StatusInfo>;
  pollIntervalMs?: number;
  now?: () => number;
  /** Test seam: replaces window.prompt for speaker rename. */
  promptFn?: (message: string, defaultValue?: string) => string | null;
}

// --- Stage model -------------------------------------------------------------

type StageKey = "upload" | "asr" | "align" | "diarize";
interface StageDef {
  key: StageKey;
  labelKey: StringKey;
  hintKey: StringKey;
  ratio: number;
}
const STAGES: StageDef[] = [
  { key: "upload", labelKey: "meeting.stepper.upload", hintKey: "meeting.stepper.upload.hint", ratio: 0 },
  { key: "asr", labelKey: "meeting.stepper.asr", hintKey: "meeting.stepper.asr.hint", ratio: 0.05 },
  { key: "align", labelKey: "meeting.stepper.align", hintKey: "meeting.stepper.align.hint", ratio: 0.1 },
  { key: "diarize", labelKey: "meeting.stepper.diarize", hintKey: "meeting.stepper.diarize.hint", ratio: 0.2 },
];
type StepState = "pending" | "active" | "complete";

const SPINNER_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 28">' +
  '<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/>' +
  "</circle></svg>";

const EDIT_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';

// --- Speaker / language options ----------------------------------------------

interface SpeakerOption {
  value: string; // serialised payload e.g. "auto" / "n=2" / "min=5,max=6"
  labelKey: StringKey;
  labelVars?: Record<string, string | number>;
  /** Resolved to API kwargs at submit time. */
  apply(opts: SubmitOptions): void;
}
const SPEAKER_OPTIONS: SpeakerOption[] = [
  { value: "auto", labelKey: "meeting.speakers.auto", apply: () => {} },
  { value: "n=1", labelKey: "meeting.speakers.n", labelVars: { n: 1 }, apply: (o) => { o.numSpeakers = 1; } },
  { value: "n=2", labelKey: "meeting.speakers.n", labelVars: { n: 2 }, apply: (o) => { o.numSpeakers = 2; } },
  { value: "n=3", labelKey: "meeting.speakers.n", labelVars: { n: 3 }, apply: (o) => { o.numSpeakers = 3; } },
  { value: "n=4", labelKey: "meeting.speakers.n", labelVars: { n: 4 }, apply: (o) => { o.numSpeakers = 4; } },
  { value: "min=5,max=6", labelKey: "meeting.speakers.range", labelVars: { min: 5, max: 6 }, apply: (o) => { o.minSpeakers = 5; o.maxSpeakers = 6; } },
  { value: "min=7", labelKey: "meeting.speakers.manyPlus", labelVars: { min: 7 }, apply: (o) => { o.minSpeakers = 7; } },
];

interface LanguageOption {
  value: string; // ISO code or "auto" / "custom"
  /** Literal labels for language names are pulled from LANGUAGE_LITERAL
   *  for the language codes; the StringKey is only used for "auto" and
   *  "custom" where the label should follow the active locale. */
  labelKey: StringKey | "_literal";
}
const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: "auto", labelKey: "meeting.language.auto" },
  { value: "zh", labelKey: "_literal" },
  { value: "en", labelKey: "_literal" },
  { value: "ja", labelKey: "_literal" },
  { value: "ko", labelKey: "_literal" },
  { value: "custom", labelKey: "meeting.language.custom" },
];
// Literal labels for language options that aren't translated (the names of
// languages are typically left in their native script across locales).
const LANGUAGE_LITERAL: Record<string, string> = {
  zh: "中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
};

// --- Page factory ------------------------------------------------------------

export function createMeetingPage(
  opts: MeetingPageOptions = {},
): MeetingPageHandle {
  const root = document.createElement("section");
  root.className = "meeting-page";
  const now = opts.now ?? (() => Date.now());
  const promptFn = opts.promptFn ?? ((m, d) => globalThis.prompt(m, d));

  // ------ DOM ---------------------------------------------------------------
  const layout = document.createElement("div");
  layout.className = "meeting-layout";

  const mainCol = document.createElement("div");
  mainCol.className = "meeting-main";

  const header = document.createElement("header");
  header.className = "meeting-header";
  const h1 = document.createElement("h1");
  h1.textContent = t("meeting.title");
  const subtitle = document.createElement("p");
  subtitle.className = "meeting-subtitle";
  subtitle.textContent = t("meeting.subtitle");
  header.append(h1, subtitle);

  const unavailableEl = document.createElement("div");
  unavailableEl.className = "meeting-unavailable";
  unavailableEl.hidden = true;

  const audioEl = document.createElement("audio");
  audioEl.className = "meeting-audio";
  audioEl.controls = true;
  audioEl.preload = "metadata";

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
  uploadTitle.textContent = t("meeting.upload.title");
  const uploadHint = document.createElement("span");
  uploadHint.className = "upload-hint";
  uploadHint.textContent = t("meeting.upload.hint");
  uploadLabel.append(fileInput, uploadIcon, uploadTitle, uploadHint);
  uploadForm.append(uploadLabel);

  // Confirm card with options grid.
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

  // Options grid: speakers select, language select, word-timestamps checkbox
  const confirmOptions = document.createElement("div");
  confirmOptions.className = "confirm-options";

  const speakersField = document.createElement("label");
  speakersField.className = "confirm-field";
  const speakersLabel = document.createElement("span");
  speakersLabel.className = "confirm-field-label";
  speakersLabel.textContent = t("meeting.confirm.speakers");
  const speakersSelect = document.createElement("select");
  speakersSelect.className = "confirm-select";
  for (const opt of SPEAKER_OPTIONS) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = t(opt.labelKey, opt.labelVars);
    speakersSelect.appendChild(o);
  }
  speakersField.append(speakersLabel, speakersSelect);

  const languageField = document.createElement("label");
  languageField.className = "confirm-field";
  const languageLabel = document.createElement("span");
  languageLabel.className = "confirm-field-label";
  languageLabel.textContent = t("meeting.confirm.language");
  const languageSelect = document.createElement("select");
  languageSelect.className = "confirm-select";
  for (const opt of LANGUAGE_OPTIONS) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent =
      opt.labelKey === "_literal"
        ? LANGUAGE_LITERAL[opt.value] ?? opt.value
        : t(opt.labelKey);
    languageSelect.appendChild(o);
  }
  languageField.append(languageLabel, languageSelect);

  const wordTsField = document.createElement("label");
  wordTsField.className = "confirm-field confirm-field-checkbox";
  const wordTsInput = document.createElement("input");
  wordTsInput.type = "checkbox";
  // Default OFF — skipping align saves ~30% time; users who want
  // word-level timing opt in explicitly. Matches the plan's decision.
  wordTsInput.checked = false;
  const wordTsText = document.createElement("span");
  wordTsText.textContent = t("meeting.confirm.wordTimestamps");
  wordTsField.append(wordTsInput, wordTsText);

  confirmOptions.append(speakersField, languageField, wordTsField);

  const confirmActions = document.createElement("div");
  confirmActions.className = "confirm-actions";
  const changeBtn = document.createElement("button");
  changeBtn.type = "button";
  changeBtn.className = "btn-secondary";
  changeBtn.textContent = t("meeting.confirm.change");
  const startBtn = document.createElement("button");
  startBtn.type = "button";
  startBtn.className = "btn-primary";
  startBtn.textContent = t("meeting.confirm.start");
  confirmActions.append(changeBtn, startBtn);

  confirmCard.append(confirmInfo, confirmOptions, confirmActions);

  // Stepper.
  const stepperEl = document.createElement("div");
  stepperEl.className = "meeting-stepper";
  stepperEl.hidden = true;
  const stepEls = new Map<StageKey, HTMLElement>();
  const stepHints = new Map<StageKey, HTMLElement>();
  const stepMarkers = new Map<StageKey, HTMLElement>();
  const stepFills = new Map<StageKey, HTMLElement>();
  STAGES.forEach(({ key, labelKey, hintKey }, idx) => {
    const step = document.createElement("div");
    step.className = "step";
    step.dataset.stage = key;
    step.dataset.state = "pending";
    const marker = document.createElement("span");
    marker.className = "step-marker";
    marker.textContent = String(idx + 1);
    const labelEl = document.createElement("span");
    labelEl.className = "step-label";
    labelEl.textContent = t(labelKey);
    const bar = document.createElement("div");
    bar.className = "step-bar";
    const fill = document.createElement("div");
    fill.className = "step-bar-fill";
    bar.appendChild(fill);
    const hintEl = document.createElement("span");
    hintEl.className = "step-hint";
    hintEl.textContent = t(hintKey);
    step.append(marker, labelEl, bar, hintEl);
    stepperEl.appendChild(step);
    stepEls.set(key, step);
    stepHints.set(key, hintEl);
    stepMarkers.set(key, marker);
    stepFills.set(key, fill);
  });

  const stopRow = document.createElement("div");
  stopRow.className = "meeting-stop-row";
  stopRow.hidden = true;
  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "btn-danger";
  stopBtn.textContent = t("meeting.stop");
  stopRow.appendChild(stopBtn);

  const errorEl = document.createElement("div");
  errorEl.className = "meeting-error";
  errorEl.hidden = true;

  const transcriptEl = document.createElement("div");
  transcriptEl.className = "meeting-transcript";

  const exportsEl = document.createElement("footer");
  exportsEl.className = "meeting-exports";
  exportsEl.hidden = true;
  const exportLabels: Record<string, string> = {
    srt: t("meeting.exports.srt"),
    vtt: t("meeting.exports.vtt"),
    txt: t("meeting.exports.txt"),
    json: t("meeting.exports.json"),
  };
  for (const fmt of ["srt", "vtt", "txt", "json"] as const) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.export = fmt;
    btn.textContent = exportLabels[fmt];
    exportsEl.appendChild(btn);
  }
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "meeting-reset btn-secondary";
  resetBtn.textContent = t("meeting.reset");
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

  const sideCol = document.createElement("aside");
  sideCol.className = "meeting-sidebar";
  const sideHeader = document.createElement("div");
  sideHeader.className = "sidebar-header";
  const sideTitle = document.createElement("h2");
  sideTitle.textContent = t("meeting.sidebar.title");
  sideHeader.appendChild(sideTitle);
  const sideList = document.createElement("ul");
  sideList.className = "sidebar-list";
  const sideEmpty = document.createElement("p");
  sideEmpty.className = "sidebar-empty";
  sideEmpty.textContent = t("meeting.sidebar.empty");
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
          ? t("meeting.unavailable.noToken")
          : m.extras_installed === false
            ? t("meeting.unavailable.noExtras")
            : t("meeting.unavailable.default");
      return { available: !!m.available, reason };
    });

  let lastResult: MeetingResult | null = null;
  let lastObjectUrl: string | null = null;
  let selectedFile: File | null = null;
  let audioDurationSeconds: number | null = null;
  let activeJobId: string | null = null;
  let abortController: AbortController | null = null;
  const stageStartedAt = new Map<StageKey, number>();
  let tickHandle: ReturnType<typeof setInterval> | null = null;
  // Speaker rename map: SPEAKER_xx → user-chosen name. Per-job, persisted
  // into history. Empty map renders original SPEAKER_xx labels.
  let speakerNames: Record<string, string> = {};

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
    }
    if (state === "complete") {
      const hint = stepHints.get(stage);
      if (hint) hint.textContent = t("meeting.stepper.done");
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
      if (hint) hint.textContent = t(s.hintKey);
      const fill = stepFills.get(s.key);
      if (fill) fill.style.width = "0%";
    });
  }

  function activateStage(stage: StageKey) {
    stepperEl.hidden = false;
    stopRow.hidden = false;
    const idx = STAGES.findIndex((s) => s.key === stage);
    if (idx < 0) return;
    for (let i = 0; i < idx; i++) {
      setStepState(STAGES[i].key, "complete");
    }
    setStepState(stage, "active");
    if (!stageStartedAt.has(stage)) stageStartedAt.set(stage, now());
    if (tickHandle === null) {
      tickHandle = setInterval(() => tickActiveStage(), 1000);
    }
    tickActiveStage();
  }

  function tickActiveStage(): void {
    const activeIdx = STAGES.findIndex(
      (s) => stepEls.get(s.key)?.dataset.state === "active",
    );
    if (activeIdx < 0) return;
    const stage = STAGES[activeIdx];
    const startedAt = stageStartedAt.get(stage.key);
    if (!startedAt) return;
    const elapsedMs = now() - startedAt;
    const elapsedSec = Math.floor(elapsedMs / 1000);

    if (stage.key === "upload") {
      const hint = stepHints.get(stage.key);
      if (hint)
        hint.textContent = t("meeting.stepper.upload.active", {
          elapsed: formatDuration(elapsedSec),
        });
      const fill = stepFills.get(stage.key);
      if (fill) {
        const pct = Math.min(85, 30 + ((elapsedSec * 8) % 56));
        fill.style.width = `${pct}%`;
      }
      return;
    }

    if (audioDurationSeconds == null || audioDurationSeconds <= 0) {
      const hint = stepHints.get(stage.key);
      if (hint)
        hint.textContent = t("meeting.stepper.elapsed", {
          elapsed: formatDuration(elapsedSec),
        });
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
          ? t("meeting.stepper.elapsedRemaining", {
              elapsed: formatDuration(elapsedSec),
              remaining: formatDuration(Math.ceil(remainingSec)),
            })
          : t("meeting.stepper.elapsed", {
              elapsed: formatDuration(elapsedSec),
            });
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
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1) + " MB";
    confirmMeta.textContent = t("meeting.confirm.metaProbing", { size: sizeMB });
    confirmCard.hidden = false;
    uploadForm.hidden = true;
    audioDurationSeconds = null;
    const probeUrl = createObjectURL(file);
    audioEl.src = probeUrl;
    const onMeta = () => {
      audioEl.removeEventListener("loadedmetadata", onMeta);
      if (Number.isFinite(audioEl.duration)) {
        audioDurationSeconds = audioEl.duration;
        confirmMeta.textContent = t("meeting.confirm.meta", {
          size: sizeMB,
          duration: formatDuration(Math.round(audioEl.duration)),
        });
      } else {
        confirmMeta.textContent = t("meeting.confirm.metaNoDuration", {
          size: sizeMB,
        });
      }
    };
    audioEl.addEventListener("loadedmetadata", onMeta);
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
    const submitOpts = buildSubmitOpts();
    hideConfirm();
    void startUpload(file, submitOpts);
  });

  function buildSubmitOpts(): SubmitOptions {
    const out: SubmitOptions = {};
    // Speakers
    const sel = SPEAKER_OPTIONS.find((o) => o.value === speakersSelect.value);
    sel?.apply(out);
    // Language
    const lang = languageSelect.value;
    if (lang === "custom") {
      const entered = promptFn(t("meeting.language.customPrompt"), "");
      if (entered && /^[a-z]{2,3}$/i.test(entered.trim()))
        out.language = entered.trim().toLowerCase();
    } else if (lang !== "auto") {
      out.language = lang;
    }
    // Word timestamps — backend default is true, our UI default is false.
    out.enableWordTimestamps = wordTsInput.checked;
    return out;
  }

  // ------ Pipeline run ------------------------------------------------------

  async function startUpload(file: File, submitOpts: SubmitOptions) {
    clearError();
    transcriptEl.replaceChildren();
    exportsEl.hidden = true;
    uploadForm.hidden = true;
    audioEl.removeAttribute("src");
    resetStepper();
    speakerNames = {};
    activateStage("upload");
    abortController = new AbortController();
    const localAbort = abortController;

    try {
      const handle = await submitMeeting(file, submitOpts);
      if (localAbort.signal.aborted) {
        void cancelMeeting(handle.job_id);
        return;
      }
      activeJobId = handle.job_id;
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
        updateHistory(handle.job_id, { status: "cancelled" });
        renderSidebar();
        return;
      }
      if (final.status === "error") {
        showError(
          t("meeting.error.pipelineFailed", {
            message: final.error?.message ?? "unknown error",
          }),
        );
        uploadForm.hidden = false;
        resetStepper();
        updateHistory(handle.job_id, { status: "error" });
        renderSidebar();
        return;
      }
      if (!final.result) {
        showError(t("meeting.error.noResult"));
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
      if (localAbort.signal.aborted) return;
      showError(
        t("meeting.error.uploadFailed", { message: (e as Error).message }),
      );
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

  function displaySpeakerName(rawSpeaker: string): string {
    return speakerNames[rawSpeaker] ?? rawSpeaker;
  }

  function renderResult(result: MeetingResult, objectUrl: string) {
    lastResult = result;
    lastObjectUrl = objectUrl;
    if (objectUrl) audioEl.src = objectUrl;
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
      // Chip text uses display name (renamed or raw).
      const chipText = document.createElement("span");
      chipText.className = "segment-meta-name";
      chipText.textContent = `${displaySpeakerName(seg.speaker)} · ${formatTime(seg.start)}`;
      // Edit pencil shown on hover.
      const editBtn = document.createElement("span");
      editBtn.className = "segment-meta-edit";
      editBtn.setAttribute("role", "button");
      editBtn.setAttribute("aria-label", t("meeting.speaker.renameTooltip"));
      editBtn.title = t("meeting.speaker.renameTooltip");
      editBtn.innerHTML = EDIT_ICON_SVG;
      editBtn.addEventListener("click", (e) => {
        // Stop the click bubbling up to the seek-on-click handler.
        e.stopPropagation();
        renameSpeaker(seg.speaker);
      });
      metaEl.append(chipText, editBtn);

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

  function renameSpeaker(rawSpeaker: string): void {
    const current = displaySpeakerName(rawSpeaker);
    const next = promptFn(
      t("meeting.speaker.renamePrompt", { speaker: rawSpeaker }),
      current === rawSpeaker ? "" : current,
    );
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === "" || trimmed === rawSpeaker) {
      delete speakerNames[rawSpeaker];
    } else {
      speakerNames = { ...speakerNames, [rawSpeaker]: trimmed };
    }
    // Persist into history so reloading still shows the rename.
    if (activeJobId) {
      updateHistory(activeJobId, { speaker_names: { ...speakerNames } });
    }
    // Re-render to update every occurrence of this speaker in the
    // transcript. We re-render the whole transcript (vs. surgically
    // touching matching nodes) because it's simple and the segment count
    // in a typical meeting is small (~hundreds).
    if (lastResult) {
      renderResult(lastResult, lastObjectUrl ?? "");
    }
  }

  function seekTo(seg: Segment) {
    if (!audioEl.src) return;
    audioEl.currentTime = seg.start;
    void audioEl.play().catch(() => {});
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

  /** Apply the active speakerNames map to every segment so exports carry
   *  the user's renames instead of raw SPEAKER_xx labels. */
  function renamedSegments(result: MeetingResult): Segment[] {
    return result.segments.map((s) => ({
      ...s,
      speaker: displaySpeakerName(s.speaker),
    }));
  }

  exportsEl
    .querySelector<HTMLButtonElement>('[data-export="srt"]')!
    .addEventListener("click", () => {
      if (!lastResult) return;
      downloadBlob(
        "meeting.srt",
        exportSpeakerSrt(renamedSegments(lastResult)),
        "application/x-subrip",
      );
    });
  exportsEl
    .querySelector<HTMLButtonElement>('[data-export="vtt"]')!
    .addEventListener("click", () => {
      if (!lastResult) return;
      downloadBlob(
        "meeting.vtt",
        exportSpeakerVtt(renamedSegments(lastResult)),
        "text/vtt",
      );
    });
  exportsEl
    .querySelector<HTMLButtonElement>('[data-export="txt"]')!
    .addEventListener("click", () => {
      if (!lastResult) return;
      downloadBlob(
        "meeting.txt",
        exportSpeakerTxt(renamedSegments(lastResult)),
        "text/plain",
      );
    });
  exportsEl
    .querySelector<HTMLButtonElement>('[data-export="json"]')!
    .addEventListener("click", () => {
      if (!lastResult) return;
      // Build a "renamed result" payload so consumers downstream see
      // user labels too. Keep raw SPEAKER_xx in a parallel `raw_speaker`
      // field so tools can correlate back to pyannote's output.
      const payload = {
        ...lastResult,
        speakers: lastResult.speakers.map((s) => displaySpeakerName(s)),
        segments: lastResult.segments.map((seg) => ({
          ...seg,
          speaker: displaySpeakerName(seg.speaker),
          raw_speaker: seg.speaker,
        })),
      };
      downloadBlob("meeting.json", JSON.stringify(payload, null, 2), "application/json");
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
    speakerNames = {};
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
    const statusStr =
      entry.status && entry.status !== "done" ? ` · ${entry.status}` : "";
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
        // Restore the saved speaker names so the transcript renders with
        // the rename the user did last time.
        speakerNames = { ...(entry.speaker_names ?? {}) };
        activeJobId = entry.job_id;
        audioEl.removeAttribute("src");
        renderResult(status.result, "");
        uploadForm.hidden = true;
        confirmCard.hidden = true;
        completeAll();
      } else if (status.status === "running" || status.status === "pending") {
        showError(t("meeting.error.stillRunning"));
      } else if (status.status === "error") {
        showError(
          t("meeting.error.jobErrored", {
            message: status.error?.message ?? "unknown",
          }),
        );
      } else if (status.status === "cancelled") {
        showError(t("meeting.error.jobCancelled"));
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("404")) {
        removeHistory(entry.job_id);
        renderSidebar();
        showError(t("meeting.error.expired"));
      } else {
        showError(t("meeting.error.loadFailed", { message: msg }));
      }
    }
  }

  renderSidebar();

  void fetchStatus()
    .then((info) => {
      if (!info.available) {
        unavailableEl.hidden = false;
        unavailableEl.textContent =
          info.reason ?? t("meeting.unavailable.default");
        fileInput.disabled = true;
        uploadLabel.classList.add("disabled");
        startBtn.disabled = true;
      }
    })
    .catch(() => {});

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
