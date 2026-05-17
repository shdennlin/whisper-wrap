/**
 * History panel: lists persisted sessions with copy / export / delete.
 *
 * Exports trigger a browser download via blob URLs; no backend round-trip.
 */

import { t } from "../i18n";
import {
  HistoryStore,
  formatSessionDuration,
  sessionDurationMs,
  type SessionRecord,
} from "../storage/history-store";
import type { StoredAudio } from "../storage/history-api-client";
import { exportSrt, exportVtt, exportTxt } from "../export/subtitle-export";
import { WaveformPlayer, type PlayerInput } from "./waveform-player";
import { ReAsrForm, type ReAsrFormDefaults, type ReAsrFormDeps } from "./re-asr-form";

export interface HistoryPanelOptions {
  root: HTMLElement;
  store: HistoryStore;
  /** Optional: resolve an action ID to its localised label. If omitted (or
   *  returns null for an unknown ID), the raw `action_id` is rendered.
   *  Resolved every render so locale switches reflect immediately. */
  resolveActionLabel?: (id: string) => string | null;
  /**
   * Lookup the stored audio record for a session. Returns null when not
   * present (either pre-capability session or audio was evicted).
   */
  getAudio?: (session_id: string) => Promise<StoredAudio | null>;
  /** ReAsrForm needs this to POST to /transcribe with the stored blob. */
  reAsrDeps?: ReAsrFormDeps;
  /** Defaults for the ReAsrForm (prompt, language, language options). */
  reAsrDefaults?: () => ReAsrFormDefaults;
}

export class HistoryPanel {
  /** Tracks active players so we can destroy them on re-render. */
  private players: WaveformPlayer[] = [];

  constructor(private readonly opts: HistoryPanelOptions) {
    this.opts.root.classList.add("history-panel");
    this.render();
  }

  render(): void {
    // Tear down any in-flight players from the previous render so we don't
    // leak event listeners / rAF tickers when the user refreshes mid-playback.
    for (const p of this.players) p.destroy();
    this.players = [];

    const sessions = this.opts.store.list();
    this.opts.root.replaceChildren();
    const header = document.createElement("h2");
    header.className = "history-title";
    header.textContent = t("history.title", { count: sessions.length });
    this.opts.root.appendChild(header);
    if (sessions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = t("history.empty");
      this.opts.root.appendChild(empty);
      return;
    }
    for (const session of sessions) {
      this.opts.root.appendChild(this.renderSession(session));
    }
  }

  private renderSession(s: SessionRecord): HTMLElement {
    const card = document.createElement("article");
    card.className = "history-card";

    const meta = document.createElement("div");
    meta.className = "history-meta";
    meta.textContent =
      formatDate(s.started_at) +
      " · " +
      (s.ended_at
        ? formatSessionDuration(sessionDurationMs(s))
        : t("history.recording")) +
      " · " +
      countWords(s) +
      t("history.charsSuffix");
    card.appendChild(meta);

    const preview = document.createElement("details");
    preview.className = "history-preview";
    const summary = document.createElement("summary");
    summary.textContent = t("history.expand");
    preview.appendChild(summary);

    // Waveform player + (optionally) Re-transcribe form. Loading is deferred
    // until the user expands the <details> so a long history doesn't spike
    // memory by decoding every session's audio on render.
    const playerHost = document.createElement("div");
    playerHost.className = "history-player-host";
    preview.appendChild(playerHost);
    const reAsrHost = document.createElement("div");
    reAsrHost.className = "history-reasr-host";
    preview.appendChild(reAsrHost);
    this.mountPlayerOnExpand(s, preview, playerHost, reAsrHost);

    const body = document.createElement("pre");
    body.className = "history-body";
    body.textContent = s.finals.map((f) => f.text).join("\n");
    preview.appendChild(body);
    if (s.action_runs.length > 0) {
      const runsHeader = document.createElement("h3");
      runsHeader.textContent = t("history.aiResponse");
      preview.appendChild(runsHeader);
      for (const run of s.action_runs) {
        const runBlock = document.createElement("div");
        runBlock.className = "history-action-run";
        const idLabel = document.createElement("strong");
        idLabel.textContent =
          this.opts.resolveActionLabel?.(run.action_id) ?? run.action_id;
        const answer = document.createElement("pre");
        answer.textContent = run.answer;
        runBlock.append(idLabel, answer);
        preview.appendChild(runBlock);
      }
    }
    card.appendChild(preview);

    const actions = document.createElement("div");
    actions.className = "history-actions";
    actions.append(
      this.makeButton(t("common.copy"), () => this.copy(s)),
      this.makeButton(t("history.exportSrt"), () => this.download(s, "srt", exportSrt)),
      this.makeButton(t("history.exportVtt"), () => this.download(s, "vtt", exportVtt)),
      this.makeButton(t("history.exportTxt"), () => this.download(s, "txt", exportTxt)),
      this.makeButton(t("common.delete"), () => this.deleteSession(s)),
    );
    card.appendChild(actions);
    return card;
  }

  /**
   * Look up this session's audio and mount the player + optional re-transcribe
   * UI on the first time the user opens the <details> for the card. Idempotent:
   * subsequent toggles do nothing because the host elements stay populated.
   *
   * Player state mapping:
   *   - audio record present                → WaveformPlayer "audio" + Re-transcribe button
   *   - record absent AND session.audio_saved → "expired" (was saved, then evicted)
   *   - record absent AND !session.audio_saved → "missing" (predates capability or save was off)
   */
  private mountPlayerOnExpand(
    s: SessionRecord,
    preview: HTMLDetailsElement,
    playerHost: HTMLElement,
    reAsrHost: HTMLElement,
  ): void {
    let mounted = false;
    const tryMount = (): void => {
      if (mounted || !preview.open) return;
      mounted = true;
      void this.attachPlayer(s, playerHost, reAsrHost);
    };
    preview.addEventListener("toggle", tryMount);
    // If the card is already open at render time (e.g. user re-render),
    // mount synchronously.
    if (preview.open) tryMount();
  }

  private async attachPlayer(
    s: SessionRecord,
    playerHost: HTMLElement,
    reAsrHost: HTMLElement,
  ): Promise<void> {
    let record: StoredAudio | null = null;
    if (this.opts.getAudio) {
      try {
        record = await this.opts.getAudio(s.id);
      } catch {
        // Treat lookup failure as missing — the player still renders gracefully.
        record = null;
      }
    }

    const input: PlayerInput = record
      ? {
          kind: "audio",
          blob: record.blob,
          mime_type: record.mime_type,
          duration_ms: record.duration_ms,
        }
      : s.audio_saved
        ? { kind: "expired" }
        : { kind: "missing" };

    const player = new WaveformPlayer({ root: playerHost, input });
    this.players.push(player);
    if (input.kind === "audio") {
      void player.load();
      // Render the Re-transcribe button only when audio is available and the
      // dependencies needed to drive it were provided.
      if (this.opts.reAsrDeps && this.opts.reAsrDefaults) {
        const reAsrDeps = this.opts.reAsrDeps;
        const reAsrDefaults = this.opts.reAsrDefaults;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "history-reasr-toggle";
        button.textContent = t("audio.reTranscribe");
        button.addEventListener("click", () => {
          button.hidden = true;
          const form = new ReAsrForm({
            ...reAsrDeps,
            onComplete: () => {
              reAsrDeps.onComplete?.();
              button.hidden = false;
              this.render();
            },
          });
          const teardown = form.mount(reAsrHost, s.id, record!.blob, reAsrDefaults());
          // Cancel re-shows the button.
          reAsrHost.addEventListener("click", function onCancel(ev) {
            const tgt = ev.target as HTMLElement;
            if (tgt.classList.contains("re-asr-cancel")) {
              button.hidden = false;
              reAsrHost.removeEventListener("click", onCancel);
              teardown();
            }
          });
        });
        reAsrHost.appendChild(button);
      }
    }
  }

  private makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  private async copy(s: SessionRecord): Promise<void> {
    const text = s.finals.map((f) => f.text).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older browsers / non-secure contexts: fall back to a temporary textarea.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }

  private download(
    s: SessionRecord,
    ext: string,
    fmt: (finals: SessionRecord["finals"]) => string,
  ): void {
    const blob = new Blob([fmt(s.finals)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `whisper-wrap-${formatDateForFilename(s.started_at)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  private deleteSession(s: SessionRecord): void {
    this.opts.store.deleteSession(s.id);
    this.render();
  }
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString("zh-TW", { hour12: false });
}

function formatDateForFilename(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function countWords(s: SessionRecord): number {
  return s.finals.reduce((acc, f) => acc + f.text.replace(/\s/g, "").length, 0);
}
