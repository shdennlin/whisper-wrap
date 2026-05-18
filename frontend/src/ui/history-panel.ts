/**
 * Slim "recent sessions" sidebar — the lightweight companion to the full
 * master-detail HistoryView at `#/history`.
 *
 * Renders at most `maxItems` (default 5) of the most recent sessions, one
 * line each: date + duration + word count + quick actions (Copy / Export /
 * Delete). Clicking the row jumps to the full HistoryView via the hash route.
 *
 * History-ux-overhaul change: the Expand / transcript-body / AI-runs /
 * waveform-player / re-transcribe machinery moved to HistoryView. This panel
 * is intentionally a glance — no Expand toggle, no nested details.
 */

import { t } from "../i18n";
import {
  HistoryStore,
  formatSessionDate,
  formatSessionDuration,
  latestActionAnswer,
  sessionDurationMs,
  sessionPreview,
  type SessionRecord,
} from "../storage/history-store";
import { exportSrt, exportVtt, exportTxt } from "../export/subtitle-export";
import { navigateToHistory } from "../routing/hash-route";

export interface HistoryPanelOptions {
  root: HTMLElement;
  store: HistoryStore;
  /** Max number of session rows to show. Defaults to 5 — sidebar is a glance,
   *  not a browser; full list lives in the master-detail HistoryView. */
  maxItems?: number;
}

export class HistoryPanel {
  private readonly maxItems: number;

  constructor(private readonly opts: HistoryPanelOptions) {
    this.maxItems = opts.maxItems ?? 5;
    this.opts.root.classList.add("history-panel");
    this.render();
  }

  render(): void {
    const all = this.opts.store.list();
    this.opts.root.replaceChildren();

    const header = document.createElement("div");
    header.className = "history-panel-header";
    const title = document.createElement("h2");
    title.className = "history-title";
    title.textContent = t("history.title", { count: all.length });
    header.appendChild(title);

    if (all.length > this.maxItems) {
      const viewAll = document.createElement("button");
      viewAll.type = "button";
      viewAll.className = "history-view-all";
      viewAll.textContent = t("history.viewAll");
      viewAll.addEventListener("click", () => navigateToHistory());
      header.appendChild(viewAll);
    }
    this.opts.root.appendChild(header);

    if (all.length === 0) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = t("history.empty");
      this.opts.root.appendChild(empty);
      return;
    }

    for (const session of all.slice(0, this.maxItems)) {
      this.opts.root.appendChild(this.renderSession(session));
    }
  }

  private renderSession(s: SessionRecord): HTMLElement {
    const card = document.createElement("article");
    card.className = "history-card";
    card.dataset.id = s.id;

    const meta = document.createElement("div");
    meta.className = "history-meta";
    const liveOrEnded = s.ended_at !== null || s.finals.length > 0;
    const dur = liveOrEnded
      ? formatSessionDuration(sessionDurationMs(s))
      : t("history.recording");
    meta.textContent = `${formatSessionDate(s.started_at)} · ${dur} · ${countWords(s)}${t("history.charsSuffix")}`;
    // Make the meta row itself a navigation target so the whole card is
    // clickable — quicker than hunting for a small label/link.
    meta.style.cursor = "pointer";
    meta.addEventListener("click", () => navigateToHistory(s.id));
    card.appendChild(meta);

    const preview = document.createElement("div");
    preview.className = "history-preview";
    const previewText = sessionPreview(s);
    preview.textContent = previewText || t("history.emptyPreview");
    if (!previewText) preview.classList.add("is-empty");
    preview.style.cursor = "pointer";
    preview.addEventListener("click", () => navigateToHistory(s.id));
    card.appendChild(preview);

    const actions = document.createElement("div");
    actions.className = "history-actions";
    const copyAiBtn = this.makeButton(t("history.copyAi"), () =>
      this.copyAi(s),
    );
    if (s.action_runs.length === 0) {
      copyAiBtn.disabled = true;
      copyAiBtn.title = t("history.copyAiNoRuns");
    }
    actions.append(
      this.makeButton(t("common.copy"), () => this.copy(s)),
      copyAiBtn,
      this.makeButton(t("history.exportSrt"), () =>
        this.download(s, "srt", exportSrt),
      ),
      this.makeButton(t("history.exportVtt"), () =>
        this.download(s, "vtt", exportVtt),
      ),
      this.makeButton(t("history.exportTxt"), () =>
        this.download(s, "txt", exportTxt),
      ),
      this.makeButton(t("common.delete"), () => this.deleteSession(s)),
    );
    card.appendChild(actions);
    return card;
  }

  private async copyAi(s: SessionRecord): Promise<void> {
    // Extract synchronously inside the click context so iOS Safari PWA's
    // permission gate sees the same gesture that triggered the copy.
    const text = latestActionAnswer(s);
    if (text === null) return;
    await this.writeClipboard(text);
  }

  private async writeClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
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

  private makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", (ev) => {
      // Don't propagate to the row's navigation handler — quick actions
      // should NOT also open the master-detail view.
      ev.stopPropagation();
      onClick();
    });
    return b;
  }

  private async copy(s: SessionRecord): Promise<void> {
    const text = s.finals.map((f) => f.text).join("\n");
    await this.writeClipboard(text);
  }

  private download(
    s: SessionRecord,
    ext: string,
    fmt: (finals: SessionRecord["finals"]) => string,
  ): void {
    const blob = new Blob([fmt(s.finals)], {
      type: "text/plain;charset=utf-8",
    });
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
    void this.opts.store.deleteSession(s.id).then(() => this.render());
  }
}

function formatDateForFilename(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function countWords(s: SessionRecord): number {
  return s.finals.reduce(
    (acc, f) => acc + f.text.replace(/\s/g, "").length,
    0,
  );
}
