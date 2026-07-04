/**
 * Recording controller (recording-controller-extract).
 *
 * The recording lifecycle — capture start/stop/pause/discard, batch-file
 * upload, live-caption sink wiring, audio persistence, upload-retry UI, and
 * health gating — extracted out of main.ts's module closure into a single
 * injectable factory unit. Every collaborator is supplied via `deps`, so the
 * start/stop/pause/discard state machine is unit-testable for the first time.
 *
 * This is a STRUCTURAL move: behavior is identical to the former main.ts
 * closure. The ~10 shared `let` bindings become private controller fields and
 * `currentSessionId` is exposed only through `activeSessionId()`; the `window`
 * pagehide persistence net moves in and is removed in `dispose()`.
 */

import { CaptureSession, shouldWarnReTranscribe } from "./capture-session";
import {
  createLiveSink,
  type LiveCaptionSink,
  type LiveStrategy,
} from "./live-caption-strategy";
import { LiveTimeoutManager, type LiveTimeoutReason } from "./live-timeout";
import { loadLiveCaptions, saveLiveCaptions } from "./mode-store";
import { type HealthMonitor } from "../health/health-monitor";
import { copyToClipboard } from "../platform/clipboard";
import { toast } from "../ui/toast";
import { modalConfirm } from "../ui/modal-prompt";
import { type SettingsPanel, loadSettings } from "../ui/settings-panel";
import { t } from "../i18n";
import { formatDuration } from "../util/format-duration";
import { MIN_USABLE_DURATION_MS, type HistoryStore } from "../storage/history-store";
import { navigateToView } from "../routing/view-route";
import { type RecordingLayer } from "../ui/recording-view";
import { client } from "../api/client";
import { backendUrl } from "../api/backend-url";

/**
 * Injected collaborators for {@link createRecordingController}. The first six
 * are the design-contract collaborators; the remaining handles bridge the
 * presentation glue the recording functions still touch but that the recording
 * layer does not own (the WS row, the upload-retry host, the legacy answer
 * pane, the mic-permission banner, and the done-item handoff).
 */
export interface RecordingControllerDeps {
  store: HistoryStore;
  healthMonitor: HealthMonitor;
  recLayer: RecordingLayer;
  /** The CURRENT live-caption strategy. A getter (not a value) because the
   *  capability is refined asynchronously from GET /models after boot — the
   *  active model may expose native streaming (asr-backend-nemotron). */
  liveStrategy: () => LiveStrategy;
  settingsPanel: SettingsPanel;
  /** Refresh every data surface after a capture changes the library. */
  onLibraryChanged: () => void;
  /** The WS-reconnect row host (only ever hidden by the lifecycle today). */
  wsIndicatorHost: HTMLElement;
  /** The in-page upload-retry prompt host. */
  uploadRetryHost: HTMLElement;
  /** Reset the legacy answer pane the way a fresh capture does. */
  resetAnswerPane: () => void;
  /** Surface a mic-permission failure (banner) for the given detail. */
  showMicPermissionError: (detail: string) => void;
  /** Hand the just-finished item id to the done-view AI bar. */
  onDoneItem: (sessionId: string) => void;
}

export interface RecordingController {
  start(): Promise<void>;
  stop(): Promise<void>;
  togglePause(): Promise<void>;
  discard(): Promise<void>;
  setLiveCaptions(on: boolean): void;
  onBatchFilePicked(file: File): Promise<void>;
  confirmBatchStart(): Promise<void>;
  syncLiveToggle(): void;
  applyHealthGating(): void;
  /** Debounced library refresh (wired to the SSE + Tauri push channels). */
  scheduleLiveRefresh(): void;
  activeSessionId(): string | null;
  dispose(): void;
}

interface PendingBatchFile {
  file: File;
  durationMs: number;
}

interface PendingUpload {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  errorMessage: string;
}

export function createRecordingController(
  deps: RecordingControllerDeps,
): RecordingController {
  const {
    store,
    healthMonitor,
    recLayer,
    liveStrategy,
    settingsPanel,
    onLibraryChanged: refreshAll,
    wsIndicatorHost,
    uploadRetryHost,
  } = deps;

  /** The single capture adapter for the shared recording overlay. */
  const captureAdapter = recLayer.batch;

  // ---- Recording lifecycle state (was main.ts closure `let`s) --------------
  let captureSession: CaptureSession | null = null;
  /** The attached live caption sink, or null when live captions are off. Held so
   *  a graceful stop can push silence frames to it and flush the last final. */
  let liveSink: LiveCaptionSink | null = null;
  let liveTimeout: LiveTimeoutManager | null = null;
  let currentSessionId: string | null = null;
  /** User preference: attach a live caption sink on record (toggleable). */
  let liveCaptionsEnabled = loadLiveCaptions();
  let recordingStartedAt = 0;
  /**
   * One-shot resolver woken by the next live `final` during a graceful stop.
   * Cleared after firing (or after the timeout) so it never crosses recordings.
   */
  let pendingStopFinalResolver: (() => void) | null = null;
  /**
   * Latest in-flight partial text for the active live session, tracked
   * independently of the UI so it survives even when the user has
   * `showPartials` off in Settings (the partial wouldn't be displayed and so
   * `recLayer.getPartial()` would return an empty string at stop time).
   * Cleared whenever the server promotes a partial to a final.
   */
  let lastLivePartialText = "";
  let pendingBatchFile: PendingBatchFile | null = null;
  let pendingUpload: PendingUpload | null = null;

  /** 250 ms silent PCM frame (16 kHz mono int16) — pushed on a graceful live stop
   *  to coax the server VAD into endpointing the in-flight utterance. */
  const SILENT_FRAME_BYTES = 4000 * 2;
  /** Push 2 s of silence (8 × 250 ms) on stop; clears any sane VAD window. */
  const GRACEFUL_STOP_SILENCE_FRAMES = 8;
  /** Hard ceiling on how long we wait for the last final after pressing stop. */
  const GRACEFUL_STOP_TIMEOUT_MS = 3000;

  // ---- Live captions cluster ----------------------------------------------

  /**
   * Reflect the live-captions toggle on the recbar from the resolved strategy +
   * current preference. Disabled (with a hint) when the active ASR has no live
   * path; otherwise checked per `liveCaptionsEnabled` with the windowed-batch
   * "approximate, re-transcribe for quality" hint.
   */
  function syncLiveToggle(): void {
    const strategy = liveStrategy();
    recLayer.setLiveToggle({
      available: strategy !== "none",
      on: liveCaptionsEnabled && strategy !== "none",
      hint:
        strategy === "none"
          ? t("rec.liveCaptionsUnavailable")
          : t("rec.liveCaptionsApprox"),
    });
  }

  /** Build + attach the windowed-batch live sink to the running session. Wires
   *  its partial/final captions into the transcript + the session record. */
  function attachLiveSink(): void {
    const strategy = liveStrategy();
    if (!captureSession || strategy === "none") return;
    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${window.location.host}/listen`;
    const sink = createLiveSink(strategy, { wsUrl });
    if (!sink) return;
    liveSink = sink;
    sink.onPartial((text) => {
      lastLivePartialText = text;
      if (loadSettings().showPartials) recLayer.setPartial(text);
      liveTimeout?.onActivity();
    });
    sink.onFinal((text, startMs, endMs) => {
      lastLivePartialText = "";
      // Wake a graceful stop waiting for the last utterance's final.
      pendingStopFinalResolver?.();
      pendingStopFinalResolver = null;
      if (currentSessionId) {
        store.appendFinal(currentSessionId, {
          text,
          start_ms: startMs,
          end_ms: endMs,
        });
      }
      recLayer.appendFinal({ text, start_ms: startMs, end_ms: endMs });
      if (loadSettings().autoScroll) {
        recLayer.scrollTranscriptToEnd();
      }
      refreshAll();
      liveTimeout?.onActivity();
    });
    captureSession.attachLiveSink(sink);
  }

  /** Detach + close the live sink; recording continues unaffected. */
  function detachLiveSink(): void {
    captureSession?.detachLiveSink();
    liveSink = null;
  }

  /** Resolve once the next live `final` arrives, or after `timeoutMs`. */
  function waitForNextFinalOr(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      pendingStopFinalResolver = settle;
      setTimeout(() => {
        if (pendingStopFinalResolver === settle) pendingStopFinalResolver = null;
        settle();
      }, timeoutMs);
    });
  }

  /**
   * Flip the live-captions preference (from the home toggle or the recbar). When
   * a capture is in flight, attach/detach the sink mid-recording with no backfill
   * (captions begin at the switch-on point).
   */
  function setLiveCaptions(on: boolean): void {
    liveCaptionsEnabled = on;
    saveLiveCaptions(on);
    syncLiveToggle();
    const capturing =
      captureSession?.state === "recording" || captureSession?.state === "paused";
    if (!capturing) return;
    if (on && liveStrategy() !== "none") attachLiveSink();
    else detachLiveSink();
  }

  // ---- Capture lifecycle ---------------------------------------------------

  async function start(): Promise<void> {
    const health = await healthMonitor.checkNow();
    if (health !== "ok") {
      toast(t("toast.backendOffline"));
      return;
    }

    hideRetryPrompt();
    recLayer.clear();
    // Reset the legacy answer pane (currentAnswerText / placeholder / hidden).
    deps.resetAnswerPane();
    recordingStartedAt = Date.now();
    lastLivePartialText = "";

    // A fresh capture replaces any lingering done view; clear its stale actions.
    recLayer.setDoneAction(null);
    recLayer.setReTranscribeAction(null);
    captureAdapter.start();
    syncLiveToggle();
    wsIndicatorHost.hidden = true;

    // Create the session record up front so live finals can append to it. The
    // stored `mode` reflects the live preference at start (advisory metadata).
    currentSessionId = store.startSession(liveCaptionsEnabled ? "live" : "batch");
    refreshAll();

    const sessionSettings = settingsPanel.getSettings();
    // Always capture the compressed blob so it is available for transcription
    // (live-off auto-transcribe) and re-transcription; persistence is gated on
    // the audio.save setting at stop time, matching the legacy batch semantics.
    captureSession = new CaptureSession({
      deviceId: sessionSettings.deviceId ?? undefined,
      saveAudio: true,
    });
    try {
      await captureSession.start();
    } catch (e) {
      deps.showMicPermissionError(e instanceof Error ? e.message : String(e));
      captureSession = null;
      if (currentSessionId) {
        store.deleteSession(currentSessionId);
        refreshAll();
      }
      currentSessionId = null;
      resetIdle();
      return;
    }

    // Feed the live mic stream to the recbar waveform; the layer stops it itself
    // when the capture leaves recording/paused.
    const stream = captureSession.getStream();
    if (stream) recLayer.startWaveform(stream);

    // Idle / hard-cap auto-stop. The idle-stop is speech-driven (live finals call
    // onActivity), so it only applies when live captions run; the hard-cap is a
    // runaway-recording ceiling that applies to any capture.
    liveTimeout = new LiveTimeoutManager({
      idleMinutes: liveCaptionsEnabled ? sessionSettings.liveIdleMinutes : 0,
      maxMinutes: sessionSettings.liveMaxMinutes,
      onTimeout: (reason: LiveTimeoutReason) => {
        toast(
          reason === "idle"
            ? t("toast.autoStopIdle", { minutes: sessionSettings.liveIdleMinutes })
            : t("toast.autoStopMax", { minutes: sessionSettings.liveMaxMinutes }),
        );
        void stop().catch(reportError);
      },
    });
    liveTimeout.start();

    // Attach the live caption sink when the user has live captions enabled.
    if (liveCaptionsEnabled && liveStrategy() !== "none") attachLiveSink();
  }

  async function togglePause(): Promise<void> {
    // The recording layer's pause control flips its own state BEFORE invoking
    // this callback — so the layer's current state already IS the next state.
    const nextState = captureAdapter.getState();
    if (!captureSession) return;
    if (nextState === "paused") captureSession.pause();
    else if (nextState === "recording") captureSession.resume();
    // Pause/resume counts as user activity — push the idle timer forward.
    liveTimeout?.onActivity();
  }

  async function discard(): Promise<void> {
    liveTimeout?.stop();
    liveTimeout = null;
    if (captureSession) {
      // Stopping the session detaches the sink + tears down mic/recorder; the
      // blob is dropped because we never persist it on the discard path.
      await captureSession.stop();
      captureSession = null;
    }
    if (currentSessionId) {
      store.deleteSession(currentSessionId);
      refreshAll();
    }
    currentSessionId = null;
    toast(t("toast.discarded"));
    resetIdle();
  }

  async function stop(): Promise<void> {
    if (!captureSession) {
      resetIdle();
      return;
    }
    liveTimeout?.stop();
    liveTimeout = null;

    // Graceful live stop (previous behavior): with a live sink attached, pause
    // the mic, push a short burst of silence so the server VAD endpoints the
    // in-flight utterance, and wait briefly for its last `final` before tearing
    // the sink down — the /listen socket discards its buffer on disconnect.
    if (liveSink) {
      captureAdapter.showProcessing(t("modeCard.confirmingFinal"));
      captureSession.pause();
      for (let i = 0; i < GRACEFUL_STOP_SILENCE_FRAMES; i++) {
        liveSink.pushFrame(new ArrayBuffer(SILENT_FRAME_BYTES));
      }
      await waitForNextFinalOr(GRACEFUL_STOP_TIMEOUT_MS);
    } else {
      captureAdapter.showProcessing();
    }

    // Flush any remaining in-flight partial as a final.
    const partial = lastLivePartialText.trim();
    if (partial && currentSessionId) {
      const ts = Math.max(0, Date.now() - recordingStartedAt);
      store.appendFinal(currentSessionId, { text: partial, start_ms: ts, end_ms: ts });
      recLayer.appendFinal({ text: partial, start_ms: ts, end_ms: ts, kind: "live" });
    }
    lastLivePartialText = "";

    const result = await captureSession.stop();
    captureSession = null;
    liveSink = null;
    wsIndicatorHost.hidden = true;

    const sessionId = currentSessionId;
    currentSessionId = null;
    if (!sessionId) {
      resetIdle();
      return;
    }

    // Finalize the session (PATCH ended_at + duration); swallow network errors —
    // the pagehide keepalive handler is the last-resort retry.
    await store.stopSession(sessionId).catch(() => {});
    const session = store.list().find((s) => s.id === sessionId);
    const dur = result.durationMs || Date.now() - recordingStartedAt;
    let hasTranscript = (session?.finals.length ?? 0) > 0;

    // Drop a too-short capture that produced no transcript.
    if (dur < MIN_USABLE_DURATION_MS && !hasTranscript) {
      store.deleteSession(sessionId);
      toast(t("toast.tooShortNotSaved", { duration: formatBriefDuration(dur) }));
      refreshAll();
      resetIdle();
      return;
    }

    // Persist the recorded blob only when the user keeps audio (the blob is
    // always captured for transcription; persistence is the opt-out).
    if (loadSettings().audioSave !== false && result.blob && result.blob.size > 0) {
      await persistAudio(sessionId, result.blob, result.durationMs);
    }

    // No live transcript → transcribe the recorded blob on stop (quick-memo
    // flow, matching the legacy batch behavior). Live captions, if any, already
    // stand as the transcript; the opt-in re-transcribe upgrades quality. A
    // failed pass keeps the audio and surfaces the manual action.
    if (!hasTranscript && result.blob && result.blob.size > 0) {
      try {
        const text = await uploadForTranscription(
          result.blob,
          result.blob.type || "application/octet-stream",
        );
        await store.appendFinal(sessionId, { text, start_ms: 0, end_ms: result.durationMs });
        recLayer.appendFinal({ text, start_ms: 0, end_ms: result.durationMs, kind: "batch" });
        hasTranscript = true;
      } catch (e) {
        toast(
          t("toast.recordFailed", {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    }

    if (hasTranscript) await maybeAutoCopy();
    refreshAll();
    finishToDone(sessionId, {
      blob: result.blob,
      durationMs: result.durationMs,
      hasTranscript,
    });
  }

  /**
   * Opt-in (re-)transcription over a finished capture's stored blob, reusing the
   * /transcribe pass. Warns first for long recordings (D5); never auto-runs. For
   * a live-off capture this is the first transcript; after live it's a
   * higher-quality pass appended to the session.
   */
  async function reTranscribeCapture(
    sessionId: string,
    blob: Blob,
    durationMs: number,
  ): Promise<void> {
    if (shouldWarnReTranscribe(durationMs)) {
      const ok = await modalConfirm(t("rec.reTranscribeWarn"));
      if (!ok) return;
    }
    recLayer.setReTranscribeAction(null);
    try {
      const text = await uploadForTranscription(
        blob,
        blob.type || "application/octet-stream",
      );
      await store.appendFinal(sessionId, { text, start_ms: 0, end_ms: durationMs });
      recLayer.appendFinal({ text, start_ms: 0, end_ms: durationMs, kind: "batch" });
      refreshAll();
      await maybeAutoCopy();
    } catch (e) {
      toast(
        t("toast.recordFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  async function processBatchRecording(
    blob: Blob,
    mimeType: string,
    durationMs: number,
  ): Promise<void> {
    try {
      const text = await uploadForTranscription(blob, mimeType);
      const sessionId = store.startSession("batch");
      await store.appendFinal(sessionId, { text, start_ms: 0, end_ms: durationMs });
      await store.stopSession(sessionId);
      recLayer.appendFinal({
        text,
        start_ms: 0,
        end_ms: durationMs,
        kind: "batch",
      });
      currentSessionId = sessionId;
      // Persist the captured blob so the user can replay or re-transcribe it
      // later. Honours the audio.save Setting; errors are isolated from the
      // upload-success path.
      if (loadSettings().audioSave !== false) {
        await persistAudio(sessionId, blob, durationMs);
      }
      refreshAll();
      await maybeAutoCopy();
      finishToDone(sessionId);
      hideRetryPrompt();
    } catch (e) {
      resetIdle();
      showRetryPrompt({
        blob,
        mimeType,
        durationMs,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ---- Batch file-upload flow ----------------------------------------------
  // Lets users transcribe a pre-recorded audio file via the same /transcribe
  // pipeline as mic-recorded clips. File → confirm card → reuse
  // processBatchRecording → history + persistence + retry-on-failure.

  /** Probe an audio file's duration via an off-DOM <audio> element. */
  function readAudioDurationMs(file: File): Promise<number> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      const cleanup = () => {
        audio.removeEventListener("loadedmetadata", onMeta);
        audio.removeEventListener("error", onError);
        URL.revokeObjectURL(url);
      };
      const onMeta = () => {
        const ms = Number.isFinite(audio.duration)
          ? Math.round(audio.duration * 1000)
          : 0;
        cleanup();
        resolve(ms);
      };
      const onError = () => {
        cleanup();
        resolve(0);
      };
      audio.addEventListener("loadedmetadata", onMeta);
      audio.addEventListener("error", onError);
      audio.src = url;
    });
  }

  async function onBatchFilePicked(file: File): Promise<void> {
    hideRetryPrompt();
    const durationMs = await readAudioDurationMs(file);
    pendingBatchFile = { file, durationMs };
    const durationLabel = durationMs > 0
      ? formatDuration(Math.round(durationMs / 1000))
      : "—";
    recLayer.batch.showConfirming(file.name, durationLabel);
    recLayer.live.setDisabled(true, t("modeCard.batchUploadPending"));
  }

  async function confirmBatchStart(): Promise<void> {
    if (!pendingBatchFile) return;
    const { file, durationMs } = pendingBatchFile;
    pendingBatchFile = null;
    recLayer.clear();
    // Reset the answer pane the same way startRecording does, so the desktop
    // layout doesn't hold a stale Q&A response next to a fresh transcript.
    deps.resetAnswerPane();
    recordingStartedAt = Date.now();
    recLayer.batch.showProcessing();
    recLayer.live.setDisabled(true, t("modeCard.processingInProgress"));
    await processBatchRecording(
      file,
      file.type || "application/octet-stream",
      durationMs,
    );
  }

  // ---- Persistence / upload / UI helpers -----------------------------------

  /**
   * Best-effort upload of `blob` to the backend for `sessionId`. The backend
   * stores the file under `data/audio/{id}{ext}` and stamps `audio_path` on
   * the session row; the HistoryStore mirrors this as `audio_saved=true`.
   * Errors surface as a toast — the transcript is already saved server-side.
   * `durationMs` is unused now (waveform player decodes its own duration).
   */
  async function persistAudio(
    sessionId: string,
    blob: Blob,
    _durationMs: number,
  ): Promise<void> {
    try {
      await store.uploadSessionAudio(sessionId, blob, blob.type || "audio/webm");
    } catch (e) {
      toast(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function maybeAutoCopy(): Promise<void> {
    if (!loadSettings().autoCopy) return;
    const text = recLayer.getText();
    if (!text) return;
    const ok = await copyToClipboard(text);
    if (ok) toast(t("toast.autoCopied"));
  }

  function showRetryPrompt(p: PendingUpload): void {
    pendingUpload = p;
    uploadRetryHost.replaceChildren();

    const message = el("span", "msg");
    message.textContent = t("uploadRetry.message", {
      duration: formatBriefDuration(p.durationMs),
      error: p.errorMessage,
    });
    const retryBtn = button(t("uploadRetry.retry"));
    retryBtn.addEventListener("click", async () => {
      if (!pendingUpload) return;
      const u = pendingUpload;
      hideRetryPrompt();
      // showProcessing() claims the capture overlay from idle directly.
      captureAdapter.showProcessing();
      await processBatchRecording(u.blob, u.mimeType, u.durationMs);
    });
    const downloadBtn = button(t("uploadRetry.downloadWebm"));
    downloadBtn.addEventListener("click", () => {
      if (!pendingUpload) return;
      downloadBlob(
        pendingUpload.blob,
        `whisper-wrap-failed-${Date.now()}.${mimeToExt(pendingUpload.mimeType)}`,
      );
    });
    const dismissBtn = button(t("uploadRetry.dismiss"));
    dismissBtn.addEventListener("click", () => hideRetryPrompt());

    uploadRetryHost.append(message, retryBtn, downloadBtn, dismissBtn);
    uploadRetryHost.hidden = false;
  }

  function hideRetryPrompt(): void {
    pendingUpload = null;
    uploadRetryHost.hidden = true;
    uploadRetryHost.replaceChildren();
  }

  function resetIdle(): void {
    recLayer.batch.reset();
    recLayer.live.reset();
    recLayer.setDoneAction(null);
    recLayer.setReTranscribeAction(null);
    applyHealthGating();
  }

  /** Re-apply current health gating + hide the WS row (shared by reset/done). */
  function applyHealthGating(): void {
    const healthy = healthMonitor.getState() === "ok";
    const title = healthy ? undefined : t("backend.disabledTitle");
    recLayer.batch.setDisabled(!healthy, title);
    recLayer.live.setDisabled(!healthy, title);
    wsIndicatorHost.hidden = true;
  }

  /**
   * Land a finished capture in the done state: transcript + actions + answer
   * re-housed under Home with an affordance to open the saved item's Detail.
   * When a recorded blob is supplied, also offer the opt-in (re-)transcribe
   * action (labelled "Transcribe" when no live transcript exists yet).
   */
  function finishToDone(
    sessionId: string,
    capture?: { blob: Blob | null; durationMs: number; hasTranscript: boolean },
  ): void {
    // A capture just landed: refresh every surface (history rail, sidebar
    // counts/recents, home recent + activity rows) so the new item appears
    // without a navigation.
    refreshAll();
    deps.onDoneItem(sessionId);
    if (captureAdapter.getState() !== "processing") captureAdapter.showProcessing();
    recLayer.setDoneAction(() => {
      navigateToView({ name: "detail", itemId: sessionId });
    });
    if (capture?.blob && capture.blob.size > 0) {
      const { blob, durationMs, hasTranscript } = capture;
      recLayer.setReTranscribeAction(
        () => void reTranscribeCapture(sessionId, blob, durationMs).catch(reportError),
        hasTranscript ? t("rec.reTranscribe") : t("rec.transcribe"),
      );
    } else {
      recLayer.setReTranscribeAction(null);
    }
    captureAdapter.markDone();
    applyHealthGating();
  }

  async function uploadForTranscription(blob: Blob, mimeType: string): Promise<string> {
    // log=false: the PWA owns its own session lifecycle via /v1/sessions/*.
    // External API consumers (Shortcut, curl) default to log=true so they
    // also appear in the history view.
    const { data, error, response } = await client.POST("/transcribe", {
      params: { query: { log: false } },
      // Binary escape hatch (design "Binary and multipart request bodies need a
      // bodySerializer + a body-type cast"): the contract types this request
      // body as a byte array (`number[]`) and openapi-fetch would JSON-serialize
      // it. Send the `Blob` verbatim via an identity `bodySerializer` and cast
      // `body` to the generated `number[]` request type. Request-body escape
      // hatch only — it does not weaken response typing.
      body: blob as unknown as number[],
      bodySerializer: () => blob,
      headers: { "content-type": mimeType || "application/octet-stream" },
    });
    if (error || !data) throw new Error(`HTTP ${response.status}`);
    return data.text ?? "";
  }

  // ---- Live library refresh (live-library-push) ----------------------------
  // While the window stays visible, an out-of-band capture — desktop
  // global-hotkey overlay, an external Shortcut/curl, or another tab — never
  // triggers the visibility re-prime, so the lists would sit stale. The SSE
  // stream + the desktop Tauri event both feed this single coalescing refresh.
  const LIVE_REFRESH_DEBOUNCE_MS = 250;
  let liveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleLiveRefresh(): void {
    if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
    liveRefreshTimer = setTimeout(() => {
      liveRefreshTimer = null;
      // Re-prime the store first so the store-backed history rail is fresh too,
      // mirroring the visibility handler (the shell + home re-fetch on their own).
      void store.prime().then(() => refreshAll());
    }, LIVE_REFRESH_DEBOUNCE_MS);
  }

  // ---- Session-id accessor + pagehide safety net ---------------------------

  function activeSessionId(): string | null {
    return currentSessionId;
  }

  // Safety net for tab close / refresh during an active recording: fire a
  // best-effort PATCH so the backend persists ended_at + duration_ms even when
  // stopSession's normal await chain never gets to run. `keepalive: true` tells
  // the browser to deliver the request after the document unloads — the
  // modern, navigateAway-safe replacement for synchronous XHR in beforeunload.
  //
  // Uses `pagehide` (not `beforeunload`) because:
  //   - pagehide fires on the bfcache path that mobile Safari uses;
  //   - beforeunload no longer fires reliably for some PWA close paths.
  function onPageHide(): void {
    if (currentSessionId === null) return;
    const session = store.list().find((s) => s.id === currentSessionId);
    if (!session || session.ended_at !== null) return;
    const ended_at = Date.now();
    // TRANSPORT EXEMPTION — this one call stays on synchronous native `fetch`,
    // NOT the generated client. openapi-fetch's request middleware defers the
    // actual `fetch` by a microtask; during `pagehide` the document can be torn
    // down before that microtask runs, dropping the request even with
    // `keepalive`. Firing `fetch` synchronously here maximises unload delivery.
    // Same-origin, so the `engine_token` cookie still rides; `keepalive: true`
    // keeps the request alive past unload.
    void fetch(`${backendUrl()}/v1/sessions/${currentSessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ended_at,
        duration_ms: ended_at - session.started_at,
      }),
      keepalive: true,
    }).catch(() => {});
  }
  window.addEventListener("pagehide", onPageHide);

  function dispose(): void {
    window.removeEventListener("pagehide", onPageHide);
  }

  // ---- Private helpers (moved verbatim from main.ts) -----------------------

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function button(label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    return b;
  }

  function formatBriefDuration(ms: number): string {
    const tenths = Math.floor(ms / 100);
    const sec = Math.floor(tenths / 10);
    const dec = tenths % 10;
    return `${sec}.${dec}s`;
  }

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function mimeToExt(mime: string): string {
    if (mime.startsWith("audio/webm")) return "webm";
    if (mime.startsWith("audio/mp4")) return "m4a";
    if (mime.startsWith("audio/ogg")) return "ogg";
    return "bin";
  }

  function reportError(e: unknown): void {
    console.error(e);
    toast(t("app.errorPrefix", { message: e instanceof Error ? e.message : String(e) }));
  }

  return {
    start,
    stop,
    togglePause,
    discard,
    setLiveCaptions,
    onBatchFilePicked,
    confirmBatchStart,
    syncLiveToggle,
    applyHealthGating,
    scheduleLiveRefresh,
    activeSessionId,
    dispose,
  };
}
