/**
 * Auxiliary model manager: the non-ASR pipeline-stage models (speaker
 * diarization + VAD), grouped by stage, each with install status and a
 * download button (with progress + cancel). Mirrors `ModelManager` but against
 * the engine's `/aux-models*` API — there's no "active" concept here; a model
 * is simply installed or not.
 *
 * This is what makes Meeting Mode fixable in-app: the diarization ONNX models
 * are no longer terminal-only (`make download-balanced`).
 */

import { modalConfirm } from "./modal-prompt";
import { t, type StringKey } from "../i18n";

interface AuxModelRow {
  id: string;
  /** "diarize" | "vad". */
  stage: string;
  size_bytes: number;
  required: boolean;
  recommended?: boolean;
  installed: boolean;
}

interface AuxModelsResponse {
  models: AuxModelRow[];
}

interface AuxDownloadStatus {
  id: string;
  status: "idle" | "downloading" | "done" | "error" | "cancelled";
  downloaded_bytes?: number;
  total_bytes?: number | null;
  error?: string | null;
  installed?: boolean;
}

type GetBackendUrl = () => string;

export interface AuxModelManagerHooks {
  /** A download finished and a model became installed (e.g. to re-check
   *  Meeting availability via /status). */
  onInstalled?: () => void;
  onError?: (message: string) => void;
}

const POLL_INTERVAL_MS = 1500;

const STAGE_LABEL: Record<string, StringKey> = {
  diarize: "aux.stageDiarize",
  vad: "aux.stageVad",
};
/** Per-stage clarifier shown under the section title. */
const STAGE_NOTE: Record<string, StringKey> = {
  diarize: "aux.diarizeNote",
};

/** label/desc now come from i18n (the engine no longer ships Chinese strings in
 *  the /aux-models JSON). The catalogue is keyed by id; map id → i18n key so the
 *  template-literal key stays type-checked against StringKey. */
const AUX_LABEL_KEY: Record<string, StringKey> = {
  "diarize-segmentation": "aux.diarize-segmentation.label",
  "diarize-embedding-fast": "aux.diarize-embedding-fast.label",
  "diarize-embedding-balanced": "aux.diarize-embedding-balanced.label",
  "vad-silero": "aux.vad-silero.label",
};
const AUX_DESC_KEY: Record<string, StringKey> = {
  "diarize-segmentation": "aux.diarize-segmentation.desc",
  "diarize-embedding-fast": "aux.diarize-embedding-fast.desc",
  "diarize-embedding-balanced": "aux.diarize-embedding-balanced.desc",
  "vad-silero": "aux.vad-silero.desc",
};
const auxLabel = (id: string): string => (AUX_LABEL_KEY[id] ? t(AUX_LABEL_KEY[id]) : id);
const auxDesc = (id: string): string | null =>
  AUX_DESC_KEY[id] ? t(AUX_DESC_KEY[id]) : null;

export class AuxModelManager {
  private readonly polling = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly root: HTMLElement,
    private readonly getBackendUrl: GetBackendUrl,
    private readonly hooks: AuxModelManagerHooks = {},
  ) {
    this.root.classList.add("model-manager", "aux-model-manager");
    void this.refresh();
  }

  dispose(): void {
    for (const id of this.polling.values()) clearInterval(id);
    this.polling.clear();
  }

  private url(path: string): string {
    return `${this.getBackendUrl()}${path}`;
  }

  private async refresh(): Promise<void> {
    this.root.textContent = "";
    let data: AuxModelsResponse;
    try {
      const resp = await fetch(this.url("/aux-models"));
      // 404 = engine predates the /aux-models endpoint. Don't vanish silently
      // (that just looks like a missing feature) — tell the user to relaunch,
      // which was the actual cause of "講者分離 模型沒有顯示".
      if (resp.status === 404) {
        const note = document.createElement("p");
        note.className = "aux-models-note";
        note.textContent = t("aux.relaunchNote");
        this.root.appendChild(note);
        return;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = (await resp.json()) as AuxModelsResponse;
    } catch (err) {
      this.renderError(t("aux.listError", { error: String(err) }));
      return;
    }
    // Group by stage, preserving catalogue order within each.
    const stages: string[] = [];
    const byStage = new Map<string, AuxModelRow[]>();
    for (const m of data.models) {
      if (!byStage.has(m.stage)) {
        byStage.set(m.stage, []);
        stages.push(m.stage);
      }
      byStage.get(m.stage)!.push(m);
    }
    for (const stage of stages) {
      const group = document.createElement("div");
      group.className = "aux-stage-group";
      const title = document.createElement("div");
      title.className = "aux-stage-title";
      title.textContent = STAGE_LABEL[stage] ? t(STAGE_LABEL[stage]) : stage;
      group.appendChild(title);
      if (STAGE_NOTE[stage]) {
        const note = document.createElement("div");
        note.className = "aux-stage-note";
        note.textContent = t(STAGE_NOTE[stage]);
        group.appendChild(note);
      }
      for (const m of byStage.get(stage)!) group.appendChild(this.renderRow(m));
      this.root.appendChild(group);
    }
  }

  private renderError(message: string): void {
    const p = document.createElement("p");
    p.className = "model-manager-error";
    p.textContent = message;
    this.root.appendChild(p);
    this.hooks.onError?.(message);
  }

  private renderRow(m: AuxModelRow): HTMLElement {
    const row = document.createElement("div");
    row.className = "model-row";
    row.dataset.id = m.id;

    const info = document.createElement("div");
    info.className = "model-row-info";
    const name = document.createElement("span");
    name.className = "model-row-name";
    name.textContent = auxLabel(m.id);
    if (m.required) {
      const req = document.createElement("span");
      req.className = "model-chip model-chip-required";
      req.textContent = t("aux.required");
      name.appendChild(req);
    } else if (m.recommended) {
      const rec = document.createElement("span");
      rec.className = "model-chip model-chip-recommended";
      rec.textContent = t("aux.recommended");
      name.appendChild(rec);
    }
    info.appendChild(name);
    const description = auxDesc(m.id);
    if (description) {
      const desc = document.createElement("span");
      desc.className = "model-row-desc";
      desc.textContent = description;
      info.appendChild(desc);
    }
    const meta = document.createElement("span");
    meta.className = "model-row-meta";
    meta.textContent = `${(m.size_bytes / 1_000_000).toFixed(0)} MB`;
    info.appendChild(meta);

    row.appendChild(info);
    row.appendChild(this.renderAction(m));
    return row;
  }

  private renderAction(m: AuxModelRow): HTMLElement {
    const slot = document.createElement("div");
    slot.className = "model-row-action";
    if (m.installed) {
      slot.appendChild(this.chip(t("aux.installed"), "active"));
      const remove = this.button(t("aux.remove"), () => void this.removeModel(m.id, auxLabel(m.id)));
      remove.classList.add("model-btn-remove");
      slot.appendChild(remove);
    } else {
      slot.appendChild(this.button(t("aux.download"), () => void this.download(m.id)));
    }
    return slot;
  }

  private async removeModel(id: string, label: string): Promise<void> {
    const ok = await modalConfirm(t("aux.removeConfirm", { label }), { okLabel: t("aux.remove") });
    if (!ok) return;
    try {
      const resp = await fetch(this.url(`/aux-models/${encodeURIComponent(id)}`), {
        method: "DELETE",
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string };
        throw new Error(body.detail ?? `HTTP ${resp.status}`);
      }
      this.hooks.onInstalled?.();
      await this.refresh();
    } catch (err) {
      this.renderError(t("aux.removeFailed", { error: String(err) }));
    }
  }

  private chip(text: string, kind: string): HTMLElement {
    const el = document.createElement("span");
    el.className = `model-chip model-chip-${kind}`;
    el.textContent = text;
    return el;
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "model-btn";
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    return btn;
  }

  private async download(id: string): Promise<void> {
    try {
      const resp = await fetch(this.url("/aux-models/download"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string };
        throw new Error(body.detail ?? `HTTP ${resp.status}`);
      }
      this.startPolling(id);
    } catch (err) {
      this.renderError(t("aux.downloadStartFailed", { error: String(err) }));
    }
  }

  private async cancelDownload(id: string): Promise<void> {
    try {
      await fetch(this.url(`/aux-models/download/${encodeURIComponent(id)}`), {
        method: "DELETE",
      });
    } catch {
      // transient — the poll reflects server truth either way
    }
  }

  private startPolling(id: string): void {
    if (this.polling.has(id)) return;
    this.markDownloading(id, null);
    const handle = setInterval(() => void this.pollOnce(id), POLL_INTERVAL_MS);
    this.polling.set(id, handle);
  }

  private async pollOnce(id: string): Promise<void> {
    let status: AuxDownloadStatus;
    try {
      const resp = await fetch(this.url(`/aux-models/download/${encodeURIComponent(id)}`));
      status = (await resp.json()) as AuxDownloadStatus;
    } catch {
      return; // transient; keep polling
    }
    if (status.status === "downloading") {
      this.markDownloading(id, status.downloaded_bytes ?? null, status.total_bytes ?? null);
      return;
    }
    this.stopPolling(id);
    if (status.status === "error") {
      this.renderError(t("aux.downloadFailed", { id, error: status.error ?? t("aux.unknownError") }));
      return;
    }
    // done / cancelled / installed → reload so the row reflects truth.
    if (status.status === "done" || status.installed) this.hooks.onInstalled?.();
    await this.refresh();
  }

  private stopPolling(id: string): void {
    const handle = this.polling.get(id);
    if (handle !== undefined) {
      clearInterval(handle);
      this.polling.delete(id);
    }
  }

  private markDownloading(id: string, bytes: number | null, total: number | null = null): void {
    const slot = this.actionSlot(id);
    if (!slot) return;
    slot.textContent = "";

    const wrap = document.createElement("div");
    wrap.className = "model-progress";
    const mb = (n: number) => (n / 1_000_000).toFixed(0);
    let label: string;
    if (total && total > 0) {
      const pct = Math.min(100, Math.round(((bytes ?? 0) / total) * 100));
      const bar = document.createElement("div");
      bar.className = "model-progress-bar";
      const fill = document.createElement("div");
      fill.className = "model-progress-fill";
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      wrap.appendChild(bar);
      label = `${pct}% · ${mb(bytes ?? 0)}/${mb(total)} MB`;
    } else {
      label = bytes && bytes > 0 ? `${t("aux.downloading")} ${mb(bytes)} MB` : t("aux.downloading");
    }
    const text = document.createElement("span");
    text.className = "model-progress-label";
    text.textContent = label;
    wrap.appendChild(text);

    const cancel = this.button(t("aux.cancel"), () => void this.cancelDownload(id));
    cancel.classList.add("model-btn-cancel");
    wrap.appendChild(cancel);

    slot.appendChild(wrap);
  }

  private actionSlot(id: string): HTMLElement | null {
    const row = this.root.querySelector<HTMLElement>(`.model-row[data-id="${CSS.escape(id)}"]`);
    return row?.querySelector<HTMLElement>(".model-row-action") ?? null;
  }
}
