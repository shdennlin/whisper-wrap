/**
 * Model management UI (v3 §12 items 1/2/4).
 *
 * Lists registry models with install status + weight license, lets the
 * user download a model's ggml weights (with progress polling) and
 * hot-swap the active model — all against the engine's /models* API.
 * Self-contained: owns its fetch + poll lifecycle so the settings
 * panel only has to mount it.
 *
 * CRUD: download (create), list (read), set-active (update), remove (delete).
 *
 * Browser-vs-desktop note: these controls work in both surfaces (the
 * API is the same), but downloading large weights is really a desktop
 * affordance — on a self-host server the operator typically pre-pulls
 * models. The UI does not hide itself per surface; the engine answers
 * identically either way.
 */

import { modalConfirm } from "./modal-prompt";
import { t } from "../i18n";
import { client } from "../api/client";
import type { components } from "../api/generated/openapi";

/** Registry row (`GET /models` element) — supersedes the hand-written `ModelRow`. */
type ModelEntry = components["schemas"]["ModelEntry"];
/**
 * `GET /models/download/{name}` progress body — an untagged `oneOf` (utoipa):
 * an Installed arm (`installed` flag) or a Progress arm (byte counters +
 * `error`). Narrowed per field by an `in`-guard on the arm's own key.
 */
type DownloadStatusResponse = components["schemas"]["DownloadStatusResponse"];

export interface ModelManagerHooks {
  /** A model was activated (weights loaded server-side). */
  onActiveChange?: () => void;
  /** A download job was accepted and polling began. */
  onDownloadStart?: () => void;
  /** Any surfaced error (download, switch, list) — fired alongside the
   *  inline message so a hidden host (backgrounded first-run gate) can
   *  re-surface it elsewhere. */
  onError?: (message: string) => void;
}

const POLL_INTERVAL_MS = 1500;

export class ModelManager {
  private readonly polling = new Map<string, ReturnType<typeof setInterval>>();
  /** Last-seen /models snapshot — drives the auto-load-after-download flow. */
  private activeName = "";
  private activeLoaded = false;
  private models: ModelEntry[] = [];
  private tab: "all" | "recommended" = "all";

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: ModelManagerHooks = {},
  ) {
    this.root.classList.add("model-manager");
    void this.refresh();
  }

  dispose(): void {
    for (const id of this.polling.values()) clearInterval(id);
    this.polling.clear();
  }

  private async refresh(): Promise<void> {
    try {
      const { data, error, response } = await client.GET("/models");
      if (error || !data) throw new Error(`HTTP ${response.status}`);
      this.activeName = data.active;
      this.activeLoaded = data.loaded === true;
      this.models = data.models;
      this.renderView();
    } catch (err) {
      this.root.textContent = "";
      this.renderError(t("model.loadError", { error: String(err) }));
    }
  }

  /** Render the tab bar + the filtered rows (re-run on tab switch, no refetch). */
  private renderView(): void {
    this.root.textContent = "";
    this.root.appendChild(this.renderTabs());
    const rows =
      this.tab === "recommended" ? this.models.filter((m) => m.recommended) : this.models;
    for (const m of rows) {
      this.root.appendChild(this.renderRow(m, m.name === this.activeName));
    }
  }

  private renderTabs(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "model-tabs";
    const mk = (key: "recommended" | "all", label: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "model-tab";
      b.classList.toggle("on", this.tab === key);
      b.textContent = label;
      b.addEventListener("click", () => {
        this.tab = key;
        this.renderView();
      });
      return b;
    };
    bar.append(mk("recommended", t("model.tabRecommended")), mk("all", t("model.tabAll")));
    return bar;
  }

  private renderError(message: string): void {
    const p = document.createElement("p");
    p.className = "model-manager-error";
    p.textContent = message;
    this.root.appendChild(p);
    this.hooks.onError?.(message);
  }

  private renderRow(m: ModelEntry, isActive: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "model-row";
    row.dataset.name = m.name;

    const info = document.createElement("div");
    info.className = "model-row-info";

    const name = document.createElement("span");
    name.className = "model-row-name";
    name.textContent = m.name;
    if (m.recommended) {
      const rec = document.createElement("span");
      rec.className = "model-chip model-chip-recommended";
      rec.textContent = t("model.recommended");
      name.appendChild(rec);
    }
    info.appendChild(name);

    if (m.description) {
      const desc = document.createElement("span");
      desc.className = "model-row-desc";
      desc.textContent = m.description;
      info.appendChild(desc);
    }

    const meta = document.createElement("span");
    meta.className = "model-row-meta";
    // size · languages · license · formats — skip empties.
    const license = m.license ?? t("model.licenseSeeCard");
    const parts = [
      m.size,
      m.languages?.length ? m.languages.join(", ") : null,
      license,
      m.formats.join(", "),
    ].filter(Boolean);
    meta.textContent = parts.join(" · ");
    info.appendChild(meta);

    if (m.speed != null || m.accuracy != null) {
      const ratings = document.createElement("span");
      ratings.className = "model-row-ratings";
      if (m.speed != null) ratings.appendChild(this.ratingEl(t("model.speed"), m.speed));
      if (m.accuracy != null) ratings.appendChild(this.ratingEl(t("model.accuracy"), m.accuracy));
      info.appendChild(ratings);
    }

    row.appendChild(info);
    row.appendChild(this.renderAction(m, isActive));
    return row;
  }

  private renderAction(m: ModelEntry, isActive: boolean): HTMLElement {
    const slot = document.createElement("div");
    slot.className = "model-row-action";

    if (!m.runnable) {
      // ggml-only engine: ct2-only models can't run here.
      slot.appendChild(this.chip(t("model.notSupported"), "muted"));
      return slot;
    }
    // "Active" requires the weights to actually be loaded — on a fresh
    // install the active *name* resolves but nothing is installed/loaded
    // yet, and the row must still offer Download (then Load).
    if (isActive && m.installed && this.activeLoaded) {
      slot.appendChild(this.chip(t("model.active"), "active"));
      return slot;
    }
    if (!m.installed) {
      slot.appendChild(this.button(t("model.download"), () => void this.download(m.name)));
      return slot;
    }
    slot.appendChild(
      this.button(isActive ? t("model.load") : t("model.setActive"), () => void this.setActive(m.name)),
    );
    // Remove (uninstall) — only for non-active models; the engine refuses to
    // delete the loaded one anyway.
    if (!isActive) {
      const remove = this.button(t("model.remove"), () => void this.removeModel(m.name));
      remove.classList.add("model-btn-remove");
      slot.appendChild(remove);
    }
    return slot;
  }

  private async removeModel(name: string): Promise<void> {
    const ok = await modalConfirm(t("model.removeConfirm", { name }), {
      okLabel: t("model.remove"),
    });
    if (!ok) return;
    try {
      const { error, response } = await client.DELETE("/models/{name}", {
        params: { path: { name } },
      });
      if (error) throw new Error(error.detail ?? `HTTP ${response.status}`);
      await this.refresh();
    } catch (err) {
      this.renderError(t("model.removeFailed", { error: String(err) }));
    }
  }

  /** A "label ●●●●○ 9.2" rating (0–10 → 5 dots), coloured by tier. */
  private ratingEl(label: string, value: number): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "model-rating";
    const lab = document.createElement("span");
    lab.className = "model-rating-label";
    lab.textContent = label;
    const dots = document.createElement("span");
    dots.className = "model-rating-dots";
    dots.dataset.tier = value >= 7 ? "high" : value >= 5 ? "mid" : "low";
    const filled = Math.round(value / 2);
    for (let i = 0; i < 5; i++) {
      const dot = document.createElement("i");
      if (i < filled) dot.className = "on";
      dots.appendChild(dot);
    }
    const num = document.createElement("span");
    num.className = "model-rating-num";
    num.textContent = value.toFixed(1);
    wrap.append(lab, dots, num);
    return wrap;
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

  private async setActive(name: string): Promise<void> {
    // Loading weights can take 10-30s (first Core ML compile) — show
    // immediate feedback instead of a seemingly dead button.
    this.markBusy(name, t("model.loading"));
    try {
      const { error, response } = await client.POST("/models/active", {
        body: { name },
      });
      if (error) throw new Error(error.detail ?? `HTTP ${response.status}`);
      this.hooks.onActiveChange?.();
      await this.refresh();
    } catch (err) {
      this.renderError(t("model.switchFailed", { error: String(err) }));
    }
  }

  private async download(name: string): Promise<void> {
    try {
      const { error, response } = await client.POST("/models/download", {
        body: { name },
      });
      if (error) throw new Error(error.detail ?? `HTTP ${response.status}`);
      this.hooks.onDownloadStart?.();
      this.startPolling(name);
    } catch (err) {
      this.renderError(t("model.downloadFailed", { error: String(err) }));
    }
  }

  private async cancelDownload(name: string): Promise<void> {
    // Fire-and-observe: the server worker notices the flag between chunks
    // and flips the job to "cancelled" — the regular poll picks that up
    // and flips the row back to Download.
    try {
      await client.DELETE("/models/download/{name}", {
        params: { path: { name } },
      });
    } catch {
      // transient — the poll keeps reflecting server truth either way
    }
  }

  private startPolling(name: string): void {
    if (this.polling.has(name)) return;
    this.markDownloading(name, null);
    const id = setInterval(() => void this.pollOnce(name), POLL_INTERVAL_MS);
    this.polling.set(name, id);
  }

  private async pollOnce(name: string): Promise<void> {
    let status: DownloadStatusResponse | undefined;
    try {
      const res = await client.GET("/models/download/{name}", {
        params: { path: { name } },
      });
      status = res.data;
    } catch {
      return; // transient network error; keep polling
    }
    if (!status) {
      // Non-OK poll (e.g. 404 no active download) — stop and reconcile from list.
      this.stopPolling(name);
      await this.refresh();
      return;
    }
    // Narrow the download-status oneOf per field: `downloaded_bytes`/`total_bytes`
    // live only on the Progress arm, so an `in`-guard on each key selects it.
    if (status.status === "downloading") {
      const bytes = "downloaded_bytes" in status ? status.downloaded_bytes : null;
      const total = "total_bytes" in status ? (status.total_bytes ?? null) : null;
      this.markDownloading(name, bytes, total);
      return;
    }
    this.stopPolling(name);
    if (status.status === "error") {
      const detail = "error" in status ? (status.error ?? "unknown") : "unknown";
      this.renderError(t("model.downloadFailedNamed", { name, error: detail }));
      return;
    }
    if (status.status === "cancelled") {
      await this.refresh(); // row flips back to Download
      return;
    }
    // done / installed. If this is the active-named model and nothing is
    // loaded yet (first-run), load it right away — one click end to end.
    if (name === this.activeName && !this.activeLoaded) {
      await this.setActive(name);
      return;
    }
    // Otherwise reload the list so the row flips to "Set active".
    await this.refresh();
  }

  private stopPolling(name: string): void {
    const id = this.polling.get(name);
    if (id !== undefined) {
      clearInterval(id);
      this.polling.delete(name);
    }
  }

  private markDownloading(name: string, bytes: number | null, total: number | null = null): void {
    const slot = this.actionSlot(name);
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
      label = bytes && bytes > 0 ? `Downloading… ${mb(bytes)} MB` : "Downloading…";
    }

    const text = document.createElement("span");
    text.className = "model-progress-label";
    text.textContent = label;
    wrap.appendChild(text);

    const cancel = this.button(t("model.cancel"), () => void this.cancelDownload(name));
    cancel.classList.add("model-btn-cancel");
    wrap.appendChild(cancel);

    slot.appendChild(wrap);
  }

  private markBusy(name: string, label: string): void {
    const slot = this.actionSlot(name);
    if (!slot) return;
    slot.textContent = "";
    slot.appendChild(this.chip(label, "busy"));
  }

  private actionSlot(name: string): HTMLElement | null {
    const row = this.root.querySelector<HTMLElement>(
      `.model-row[data-name="${CSS.escape(name)}"]`,
    );
    return row?.querySelector<HTMLElement>(".model-row-action") ?? null;
  }
}
