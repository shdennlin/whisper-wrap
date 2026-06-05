/**
 * Meeting Mode page wiring.
 *
 * Composes upload control + progress indicator + speaker-coloured transcript
 * + click-to-seek audio player + speaker-aware export buttons. Lives at
 * `/app/meeting`.
 *
 * The page is intentionally vanilla DOM — no framework — to match the rest
 * of the PWA shell.
 */

import { exportSpeakerSrt } from "../export/speaker-srt";
import { exportSpeakerTxt } from "../export/speaker-txt";
import { exportSpeakerVtt } from "../export/speaker-vtt";
import { pollUntilDone, submitMeeting } from "./meeting-api";
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
}

export function createMeetingPage(
  opts: MeetingPageOptions = {},
): MeetingPageHandle {
  const root = document.createElement("section");
  root.className = "meeting-page";
  root.innerHTML = `
    <header class="meeting-header">
      <h1>Meeting Mode</h1>
      <p class="meeting-subtitle">Upload a meeting recording to get speaker-labelled transcripts with word-level timestamps.</p>
    </header>
    <div class="meeting-unavailable" hidden></div>
    <audio class="meeting-audio" controls preload="metadata"></audio>
    <form class="meeting-upload">
      <label class="upload-button">
        <input type="file" accept="audio/*" />
        <span>Choose audio file…</span>
      </label>
    </form>
    <div class="meeting-progress" hidden>
      <span class="progress-stage"></span>
      <progress class="progress-bar" max="1" value="0"></progress>
    </div>
    <div class="meeting-error" hidden></div>
    <div class="meeting-transcript"></div>
    <footer class="meeting-exports" hidden>
      <button data-export="srt">Download SRT</button>
      <button data-export="vtt">Download VTT</button>
      <button data-export="txt">Download TXT</button>
    </footer>
  `;

  const audioEl = root.querySelector<HTMLAudioElement>(".meeting-audio")!;
  const fileInput = root.querySelector<HTMLInputElement>(
    ".meeting-upload input[type=file]",
  )!;
  const uploadLabel = root.querySelector<HTMLLabelElement>(".upload-button")!;
  const unavailableEl =
    root.querySelector<HTMLDivElement>(".meeting-unavailable")!;
  const progressEl = root.querySelector<HTMLDivElement>(".meeting-progress")!;
  const progressStage =
    root.querySelector<HTMLSpanElement>(".progress-stage")!;
  const progressBar = root.querySelector<HTMLProgressElement>(".progress-bar")!;
  const errorEl = root.querySelector<HTMLDivElement>(".meeting-error")!;
  const transcriptEl =
    root.querySelector<HTMLDivElement>(".meeting-transcript")!;
  const exportsEl = root.querySelector<HTMLElement>(".meeting-exports")!;

  const fetchFn = opts.fetchFn ?? fetch;
  const createObjectURL =
    opts.createObjectURL ??
    (typeof URL !== "undefined" && URL.createObjectURL?.bind(URL)) ??
    (() => "");
  const fetchStatus =
    opts.fetchStatus ??
    (async () => {
      const resp = await fetchFn("/status");
      const body = await resp.json();
      const m = body?.meeting ?? {};
      const reason = m.available
        ? undefined
        : (m.hf_token_configured === false
            ? "HF_TOKEN is not configured"
            : m.extras_installed === false
              ? "meeting extras not installed"
              : "Meeting analysis is unavailable.");
      return { available: !!m.available, reason };
    });

  let lastResult: MeetingResult | null = null;
  let lastObjectUrl: string | null = null;

  function showError(message: string) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.textContent = "";
    errorEl.hidden = true;
  }

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
      item.style.borderLeft = `4px solid ${colors.get(seg.speaker) ?? "#999"}`;

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
    progressEl.hidden = true;
  }

  function seekTo(seg: Segment) {
    audioEl.currentTime = seg.start;
    void audioEl.play().catch(() => {
      // Autoplay block — that's fine; the user can hit play themselves.
    });
  }

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

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    clearError();
    progressEl.hidden = false;
    progressStage.textContent = "Uploading…";
    progressBar.value = 0;

    try {
      const handle = await submitMeeting(file);
      const objectUrl = createObjectURL(file);
      const final = await pollUntilDone(
        handle.status_url,
        (status: JobStatusResponse) => {
          progressStage.textContent = `Stage: ${status.stage} · ${Math.round(status.progress * 100)}%`;
          progressBar.value = status.progress;
        },
        opts.pollIntervalMs ?? 2000,
      );
      if (final.status === "error") {
        showError(
          `Pipeline failed: ${final.error?.message ?? "unknown error"}`,
        );
        progressEl.hidden = true;
        return;
      }
      if (!final.result) {
        showError("Pipeline returned no result.");
        progressEl.hidden = true;
        return;
      }
      renderResult(final.result, objectUrl);
    } catch (e) {
      showError(`Upload error: ${(e as Error).message}`);
      progressEl.hidden = true;
    }
  });

  // Disable the upload control if meeting analysis is unavailable.
  void fetchStatus()
    .then((info) => {
      if (!info.available) {
        unavailableEl.hidden = false;
        unavailableEl.textContent =
          info.reason ?? "Meeting analysis is unavailable.";
        fileInput.disabled = true;
        uploadLabel.classList.add("disabled");
      }
    })
    .catch(() => {
      // If /status fails entirely, leave the page enabled — the user will
      // see the 503 on submit instead, which is also informative.
    });

  return {
    element: root,
    renderResult(result, objectUrl) {
      renderResult(result, objectUrl);
    },
  };
}

function cssSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
