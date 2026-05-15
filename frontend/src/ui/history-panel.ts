/**
 * History panel: lists persisted sessions with copy / export / delete.
 *
 * Exports trigger a browser download via blob URLs; no backend round-trip.
 */

import { HistoryStore, type SessionRecord } from "../storage/history-store";
import { exportSrt, exportVtt, exportTxt } from "../export/subtitle-export";

export interface HistoryPanelOptions {
  root: HTMLElement;
  store: HistoryStore;
}

export class HistoryPanel {
  constructor(private readonly opts: HistoryPanelOptions) {
    this.opts.root.classList.add("history-panel");
    this.render();
  }

  render(): void {
    const sessions = this.opts.store.list();
    this.opts.root.replaceChildren();
    const header = document.createElement("h2");
    header.className = "history-title";
    header.textContent = `對話記錄（${sessions.length}）`;
    this.opts.root.appendChild(header);
    if (sessions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "尚無記錄。按錄音鍵開始第一段。";
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
      (s.ended_at ? formatDuration(s.ended_at - s.started_at) : "錄音中") +
      " · " +
      countWords(s) +
      " 字";
    card.appendChild(meta);

    const preview = document.createElement("details");
    preview.className = "history-preview";
    const summary = document.createElement("summary");
    summary.textContent = "展開內容";
    preview.appendChild(summary);
    const body = document.createElement("pre");
    body.className = "history-body";
    body.textContent = s.finals.map((f) => f.text).join("\n");
    preview.appendChild(body);
    if (s.action_runs.length > 0) {
      const runsHeader = document.createElement("h3");
      runsHeader.textContent = "AI 回應";
      preview.appendChild(runsHeader);
      for (const run of s.action_runs) {
        const runBlock = document.createElement("div");
        runBlock.className = "history-action-run";
        const idLabel = document.createElement("strong");
        idLabel.textContent = run.action_id;
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
      this.makeButton("複製", () => this.copy(s)),
      this.makeButton("匯出 SRT", () => this.download(s, "srt", exportSrt)),
      this.makeButton("匯出 VTT", () => this.download(s, "vtt", exportVtt)),
      this.makeButton("匯出 TXT", () => this.download(s, "txt", exportTxt)),
      this.makeButton("刪除", () => this.deleteSession(s)),
    );
    card.appendChild(actions);
    return card;
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

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function countWords(s: SessionRecord): number {
  return s.finals.reduce((acc, f) => acc + f.text.replace(/\s/g, "").length, 0);
}
