/**
 * Master-detail History view, mounted on the hash route `#/history` /
 * `#/history/<id>`. The component owns its own DOM tree; mount/unmount is
 * driven by the route handler in `main.ts`.
 *
 * Replaces the old right-sidebar `HistoryPanel` (which still ships for the
 * recording shell's mini-card view but no longer carries the full history
 * UI). The rail lives on the left, the detail on the right; both regions
 * scroll independently inside the viewport so neither overflows the page.
 *
 * Re-runnable AI Actions: the detail panel exposes an "Add AI Action"
 * picker. The actual `/ask` round-trip is delegated to a `runActionAgain`
 * callback supplied at construction (so this component stays decoupled
 * from the fetch/settings stack and is trivial to test).
 */

import { t } from "../i18n";
import { navigateToHistory } from "../routing/hash-route";
import {
  HistoryStore,
  formatSessionDate,
  formatSessionDuration,
  latestActionAnswer,
  sessionDurationMs,
  sessionPreview,
  type ActionRun,
  type SessionRecord,
} from "../storage/history-store";
import type { StoredAudio } from "../storage/history-api-client";
import { exportSrt, exportTxt, exportVtt } from "../export/subtitle-export";
import { WaveformPlayer, type PlayerInput } from "./waveform-player";
import {
  ReAsrForm,
  type ReAsrFormDefaults,
  type ReAsrFormDeps,
} from "./re-asr-form";

const SEARCH_DEBOUNCE_MS = 120;

export interface ActionChoice {
  /** Backend action id (matches `registry/actions.yaml`). */
  id: string;
  /** Localised label rendered in the picker dropdown. */
  label: string;
  /** Template string with `{transcript}` placeholder. */
  template: string;
}

export interface HistoryViewOptions {
  root: HTMLElement;
  store: HistoryStore;
  /** Resolve an action id to its localised label for runs already in
   *  history. Returns null for unknown ids; the raw id is shown then. */
  resolveActionLabel?: (id: string) => string | null;
  /** Source of available action templates for the "Add AI Action" picker.
   *  Called every time the picker opens so locale changes / hot reloads
   *  show fresh entries. */
  listActions?: () => ActionChoice[];
  /** Stored audio lookup for the waveform player. */
  getAudio?: (sessionId: string) => Promise<StoredAudio | null>;
  /** Run an action against an existing transcript. Returns the assistant
   *  answer string. Errors propagate so HistoryView can show the inline
   *  error and avoid persisting a failed run. */
  runActionAgain?: (
    sessionId: string,
    actionId: string,
    prompt: string,
  ) => Promise<string>;
  /** Dependencies for the inline "Re-transcribe" form mounted next to the
   *  waveform player. When absent, the button is not rendered (graceful
   *  degradation for tests + environments without /transcribe wiring). */
  reAsrDeps?: ReAsrFormDeps;
  /** Defaults snapshot resolved each time the form opens so locale /
   *  settings changes take effect immediately. */
  reAsrDefaults?: () => ReAsrFormDefaults;
}

export class HistoryView {
  private wrapper: HTMLElement | null = null;
  private rail: HTMLElement | null = null;
  private detail: HTMLElement | null = null;
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  private searchQuery = "";
  /** Sessions whose re-run is currently in flight. Used as a per-session
   *  single-flight guard (per spec scenario "concurrent re-run guard"). */
  private inFlightRuns = new Set<string>();
  private players: WaveformPlayer[] = [];
  private currentSessionId: string | null = null;

  constructor(private readonly opts: HistoryViewOptions) {}

  /** Render the master-detail layout. `sessionId === null` shows the empty
   *  detail panel; any other id selects (or shows "not found"). */
  show(sessionId: string | null): void {
    if (!this.wrapper) this.mountShell();
    this.currentSessionId = sessionId;
    this.renderRail();
    this.renderDetail(sessionId);
    if (this.wrapper) this.wrapper.hidden = false;
  }

  /** Hide the view without destroying it; subsequent `show()` re-mounts state. */
  hide(): void {
    if (this.wrapper) this.wrapper.hidden = true;
  }

  /** Incremental refresh after the store mutates externally (recording stop,
   *  re-run, delete). Only re-paints the rail — cheap and leaves the detail
   *  pane (waveform player position, scroll, in-flight runs) untouched. If
   *  the detail is showing a session whose data changed, the user will see
   *  it next time they click it; we don't disturb their current interaction. */
  refresh(): void {
    if (!this.wrapper || this.wrapper.hidden) return;
    this.renderRail();
  }

  /** Permanently remove the view and clean up event listeners + players. */
  destroy(): void {
    this.destroyPlayers();
    if (this.searchDebounce) {
      clearTimeout(this.searchDebounce);
      this.searchDebounce = null;
    }
    if (this.wrapper) {
      this.wrapper.remove();
      this.wrapper = null;
      this.rail = null;
      this.detail = null;
    }
  }

  // ============ Shell + rail ============

  private mountShell(): void {
    const wrapper = document.createElement("div");
    wrapper.className = "history-view";
    wrapper.dataset.testid = "history-view";

    const rail = document.createElement("aside");
    rail.className = "history-rail";

    // Back affordance: a reliable in-app exit so users don't have to depend
    // on the browser back button (which may exit the app entirely if the
    // history depth is 1). Clearing the hash drops us back into the shell.
    const back = document.createElement("button");
    back.type = "button";
    back.className = "history-back-btn";
    back.dataset.testid = "history-back";
    back.textContent = t("history.backToShell");
    back.addEventListener("click", () => {
      window.location.hash = "";
    });
    rail.appendChild(back);

    const search = document.createElement("input");
    search.type = "search";
    search.className = "history-search";
    search.placeholder = t("history.searchPlaceholder");
    search.dataset.testid = "history-search";
    search.addEventListener("input", () => this.onSearchInput(search.value));
    rail.appendChild(search);

    const list = document.createElement("ul");
    list.className = "history-list";
    rail.appendChild(list);

    const detail = document.createElement("section");
    detail.className = "history-detail";
    detail.dataset.testid = "history-detail";

    wrapper.append(rail, detail);
    this.opts.root.appendChild(wrapper);

    this.wrapper = wrapper;
    this.rail = rail;
    this.detail = detail;
  }

  private renderRail(): void {
    if (!this.rail) return;
    const list = this.rail.querySelector(".history-list");
    if (!list) return;
    list.replaceChildren();

    const sessions = this.filteredSessions();
    if (sessions.length === 0) {
      const empty = document.createElement("li");
      empty.className = "history-rail-empty";
      empty.textContent = t("history.empty");
      list.appendChild(empty);
      return;
    }

    for (const s of sessions) {
      const row = document.createElement("li");
      row.className = "history-row";
      row.dataset.id = s.id;
      if (s.id === this.currentSessionId) row.classList.add("is-selected");

      const date = document.createElement("div");
      date.className = "history-row-date";
      date.textContent = formatSessionDate(s.started_at);

      const meta = document.createElement("div");
      meta.className = "history-row-meta";
      // Show duration even when ended_at is missing — sessionDurationMs has a
      // finals-based fallback so a stored session with content never reads
      // "Recording" by mistake.
      const liveOrEnded = s.ended_at !== null || s.finals.length > 0;
      const dur = liveOrEnded
        ? formatSessionDuration(sessionDurationMs(s))
        : t("history.recording");
      meta.textContent = `${dur} · ${countWords(s)}${t("history.charsSuffix")}`;

      const preview = document.createElement("div");
      preview.className = "history-row-preview";
      const previewText = sessionPreview(s);
      preview.textContent = previewText || t("history.emptyPreview");
      if (!previewText) preview.classList.add("is-empty");

      const actions = this.renderRowQuickActions(s);

      row.append(date, meta, preview, actions);
      row.addEventListener("click", () => {
        // The hash route is the source of truth — let the route handler
        // call `show(id)` rather than mutating the view directly here.
        navigateToHistory(s.id);
      });
      list.appendChild(row);
    }
  }

  /** Inline quick actions shown on the rail row so users don't have to enter
   *  the detail panel to copy / export / delete. Matches the slim sidebar's
   *  button set for cross-UI consistency. */
  private renderRowQuickActions(s: SessionRecord): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "history-row-actions";
    const mk = (
      label: string,
      handler: () => void | Promise<void>,
      disabled = false,
    ): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener("click", (ev) => {
        // Don't bubble to the row's navigation handler — quick actions are
        // explicit operations, not "enter detail" gestures.
        ev.stopPropagation();
        void handler();
      });
      return b;
    };
    wrap.append(
      mk(t("common.copy"), () => writeClipboard(joinFinals(s))),
      mk(
        t("history.copyAi"),
        () => {
          const text = latestActionAnswer(s);
          if (text !== null) return writeClipboard(text);
        },
        s.action_runs.length === 0,
      ),
      mk(t("history.exportSrt"), () => downloadAs(s, "srt", exportSrt)),
      mk(t("history.exportVtt"), () => downloadAs(s, "vtt", exportVtt)),
      mk(t("history.exportTxt"), () => downloadAs(s, "txt", exportTxt)),
      mk(t("common.delete"), () => this.deleteRowSession(s)),
    );
    return wrap;
  }

  private async deleteRowSession(s: SessionRecord): Promise<void> {
    if (!window.confirm(t("history.deleteRunConfirm"))) return;
    try {
      await this.opts.store.deleteSession(s.id);
    } finally {
      // Stay on history view; if the current detail was the deleted session,
      // navigate to the bare history route.
      if (this.currentSessionId === s.id) {
        navigateToHistory();
      } else {
        this.renderRail();
      }
    }
  }

  private filteredSessions(): SessionRecord[] {
    const all = this.opts.store.list();
    if (!this.searchQuery) return all;
    const q = this.searchQuery.toLowerCase();
    return all.filter((s) => {
      const date = formatSessionDate(s.started_at).toLowerCase();
      if (date.includes(q)) return true;
      const text = s.finals.map((f) => f.text).join("\n").toLowerCase();
      return text.includes(q);
    });
  }

  private onSearchInput(value: string): void {
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => {
      this.searchQuery = value.trim();
      this.renderRail();
    }, SEARCH_DEBOUNCE_MS);
  }

  // ============ Detail panel ============

  private renderDetail(sessionId: string | null): void {
    if (!this.detail) return;
    this.destroyPlayers();
    this.detail.replaceChildren();

    if (sessionId === null) {
      const empty = document.createElement("div");
      empty.className = "history-detail-empty";
      empty.textContent = t("history.selectPrompt");
      this.detail.appendChild(empty);
      return;
    }

    const session = this.opts.store.list().find((s) => s.id === sessionId);
    if (!session) {
      const missing = document.createElement("div");
      missing.className = "history-detail-empty";
      missing.textContent = t("history.sessionNotFound");
      this.detail.appendChild(missing);
      return;
    }

    this.detail.appendChild(this.renderDetailHeader(session));
    this.detail.appendChild(this.renderTranscript(session));

    const runsHost = document.createElement("div");
    runsHost.className = "history-runs";
    runsHost.dataset.testid = "history-runs";
    this.renderRunsInto(runsHost, session);
    this.detail.appendChild(runsHost);

    this.detail.appendChild(this.renderAddActionControl(session, runsHost));

    // Audio player loads lazily after the detail mounts (matches the old
    // panel behavior of deferring decode until the user expands the card).
    if (this.opts.getAudio) {
      const playerHost = document.createElement("div");
      playerHost.className = "history-player-host";
      this.detail.appendChild(playerHost);
      void this.attachPlayer(session, playerHost);
    }
  }

  private renderDetailHeader(session: SessionRecord): HTMLElement {
    const header = document.createElement("header");
    header.className = "history-detail-header";
    const meta = document.createElement("p");
    meta.className = "history-detail-meta";
    const liveOrEnded = session.ended_at !== null || session.finals.length > 0;
    const dur = liveOrEnded
      ? formatSessionDuration(sessionDurationMs(session))
      : t("history.recording");
    meta.textContent = `${formatSessionDate(session.started_at)} · ${dur} · ${countWords(session)}${t("history.charsSuffix")}`;
    header.appendChild(meta);
    return header;
  }

  private renderTranscript(session: SessionRecord): HTMLElement {
    const pre = document.createElement("pre");
    pre.className = "history-transcript";
    pre.textContent = session.finals.map((f) => f.text).join("\n");
    return pre;
  }

  private renderRunsInto(host: HTMLElement, session: SessionRecord): void {
    host.replaceChildren();
    if (session.action_runs.length === 0) return;
    const heading = document.createElement("h3");
    heading.textContent = t("history.aiResponse");
    host.appendChild(heading);

    // Sort by ran_at DESC so newest is at the top.
    const sorted = [...session.action_runs].sort((a, b) => b.ran_at - a.ran_at);
    for (const run of sorted) {
      host.appendChild(this.renderRunRow(session.id, run));
    }
  }

  private renderRunRow(sessionId: string, run: ActionRun): HTMLElement {
    const row = document.createElement("article");
    row.className = "history-run";
    if (run.id !== undefined) row.dataset.runId = String(run.id);

    const headerRow = document.createElement("div");
    headerRow.className = "history-run-header";

    const label = document.createElement("strong");
    label.className = "history-run-label";
    label.textContent =
      this.opts.resolveActionLabel?.(run.action_id) ?? run.action_id;
    headerRow.appendChild(label);

    const stamp = document.createElement("time");
    stamp.className = "history-run-time";
    stamp.dateTime = new Date(run.ran_at).toISOString();
    stamp.textContent = formatSessionDate(run.ran_at);
    headerRow.appendChild(stamp);

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "history-run-copy";
    copyBtn.textContent = t("common.copy");
    copyBtn.addEventListener("click", () => {
      // Capture the text BEFORE any await so iOS Safari's user-gesture
      // gate sees the same click context.
      const text = run.answer;
      void writeClipboard(text);
    });
    headerRow.appendChild(copyBtn);

    if (run.id !== undefined) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "history-run-delete";
      del.textContent = t("history.deleteRunButton");
      del.addEventListener("click", () =>
        this.confirmAndDeleteRun(sessionId, run.id!, row),
      );
      headerRow.appendChild(del);
    }
    row.appendChild(headerRow);

    const answer = document.createElement("pre");
    answer.className = "history-run-answer";
    answer.textContent = run.answer;
    row.appendChild(answer);

    return row;
  }

  private async confirmAndDeleteRun(
    sessionId: string,
    runId: number,
    row: HTMLElement,
  ): Promise<void> {
    if (!window.confirm(t("history.deleteRunConfirm"))) return;
    try {
      await this.opts.store.deleteRun(sessionId, runId);
      // Surgical removal: drop just this row without re-rendering the whole
      // detail panel (preserves scroll position + player state).
      row.remove();
      const remaining = this.detail?.querySelectorAll(".history-run").length ?? 0;
      if (remaining === 0) {
        const heading = this.detail?.querySelector(".history-runs h3");
        heading?.remove();
      }
    } catch {
      // HistoryStore already fires onError; leaving the row in place is the
      // visible signal that the delete didn't take effect.
    }
  }

  private renderAddActionControl(
    session: SessionRecord,
    runsHost: HTMLElement,
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "history-add-action";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-add-action-btn";
    button.dataset.testid = "add-ai-action";
    button.textContent = t("history.addActionRun");
    const inFlight = this.inFlightRuns.has(session.id);
    if (inFlight) button.disabled = true;

    button.addEventListener("click", () => {
      // Concurrent-guard: a second click while the first is in flight is a
      // no-op. The disabled attribute is the user-visible signal.
      if (this.inFlightRuns.has(session.id)) return;
      void this.handleAddAction(session, runsHost, button);
    });

    wrap.appendChild(button);

    const picker = document.createElement("div");
    picker.className = "history-action-picker";
    picker.hidden = true;
    picker.dataset.testid = "action-picker";
    wrap.appendChild(picker);

    return wrap;
  }

  private async handleAddAction(
    session: SessionRecord,
    runsHost: HTMLElement,
    button: HTMLButtonElement,
  ): Promise<void> {
    const wrap = button.parentElement!;
    const picker = wrap.querySelector<HTMLElement>(".history-action-picker");
    if (!picker) return;

    // Build the picker UI inline: a <select> seeded with all actions.
    const actions = this.opts.listActions?.() ?? [];
    if (actions.length === 0) {
      // Nothing to pick — surface a tiny inline message and bail.
      picker.replaceChildren(document.createTextNode(t("history.empty")));
      picker.hidden = false;
      return;
    }
    picker.replaceChildren();
    const select = document.createElement("select");
    select.className = "history-action-select";
    for (const a of actions) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.label;
      select.appendChild(opt);
    }
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "history-action-apply";
    apply.textContent = t("history.addActionRun");
    picker.append(select, apply);
    picker.hidden = false;

    apply.addEventListener(
      "click",
      () => {
        void this.runPickedAction(
          session,
          actions,
          select.value,
          button,
          picker,
          runsHost,
        );
      },
      { once: true },
    );
  }

  private async runPickedAction(
    session: SessionRecord,
    actions: ActionChoice[],
    actionId: string,
    button: HTMLButtonElement,
    picker: HTMLElement,
    runsHost: HTMLElement,
  ): Promise<void> {
    const action = actions.find((a) => a.id === actionId);
    if (!action) return;
    const cb = this.opts.runActionAgain;
    if (!cb) return;

    this.inFlightRuns.add(session.id);
    button.disabled = true;
    picker.hidden = true;

    const transcript = session.finals.map((f) => f.text).join("\n");
    const prompt = action.template.replace(/\{transcript\}/g, transcript);

    try {
      const answer = await cb(session.id, action.id, prompt);
      await this.opts.store.appendActionRun(session.id, {
        action_id: action.id,
        prompt,
        answer,
        ran_at: Date.now(),
      });
      // Re-render only the runs subtree so the player + transcript stay put.
      const fresh = this.opts.store.list().find((s) => s.id === session.id);
      if (fresh) this.renderRunsInto(runsHost, fresh);
    } catch {
      // store/runActionAgain are expected to surface their own toasts; leave
      // the button re-enabled below so the user can retry.
    } finally {
      this.inFlightRuns.delete(session.id);
      button.disabled = false;
    }
  }

  // ============ Player ============

  private async attachPlayer(
    session: SessionRecord,
    playerHost: HTMLElement,
  ): Promise<void> {
    let record: StoredAudio | null = null;
    try {
      record = (await this.opts.getAudio?.(session.id)) ?? null;
    } catch {
      record = null;
    }
    const input: PlayerInput = record
      ? {
          kind: "audio",
          blob: record.blob,
          mime_type: record.mime_type,
          duration_ms: record.duration_ms,
        }
      : session.audio_saved
        ? { kind: "expired" }
        : { kind: "missing" };
    const player = new WaveformPlayer({ root: playerHost, input });
    this.players.push(player);
    if (input.kind === "audio") void player.load();

    // Re-transcribe button (regression repair from 10ac686): only when the
    // session has stored audio AND the host wired in /transcribe + history
    // deps. Form mounts inline on click; cancel/complete re-show the button.
    if (
      input.kind === "audio" &&
      record &&
      this.opts.reAsrDeps &&
      this.opts.reAsrDefaults
    ) {
      const blob = record.blob;
      const deps = this.opts.reAsrDeps;
      const defaultsFn = this.opts.reAsrDefaults;
      const reAsrHost = document.createElement("div");
      reAsrHost.className = "history-reasr";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "history-reasr-toggle";
      button.dataset.testid = "re-asr-toggle";
      button.textContent = t("audio.reTranscribe");
      const formHost = document.createElement("div");
      formHost.className = "history-reasr-form-host";
      button.addEventListener("click", () => {
        button.hidden = true;
        const form = new ReAsrForm({
          ...deps,
          onComplete: () => {
            deps.onComplete?.();
            // Full detail re-render picks up the new ActionRun and brings
            // the button back. Cheaper alternatives risk staleness if the
            // store grew runs from another path in the meantime.
            this.renderDetail(this.currentSessionId);
          },
        });
        const teardown = form.mount(formHost, session.id, blob, defaultsFn());
        const onCancel = (ev: Event): void => {
          const tgt = ev.target as HTMLElement;
          if (tgt.classList.contains("re-asr-cancel")) {
            formHost.removeEventListener("click", onCancel);
            teardown();
            button.hidden = false;
          }
        };
        formHost.addEventListener("click", onCancel);
      });
      reAsrHost.append(button, formHost);
      playerHost.appendChild(reAsrHost);
    }
  }

  private destroyPlayers(): void {
    for (const p of this.players) p.destroy();
    this.players = [];
  }
}


function joinFinals(s: SessionRecord): string {
  return s.finals.map((f) => f.text).join("\n");
}

function downloadAs(
  s: SessionRecord,
  ext: string,
  fmt: (finals: SessionRecord["finals"]) => string,
): void {
  const blob = new Blob([fmt(s.finals)], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const d = new Date(s.started_at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `whisper-wrap-${stamp}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for environments without async clipboard permission (older iOS,
    // insecure contexts). Synchronous selectCopy on an invisible textarea.
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

function countWords(s: SessionRecord): number {
  return s.finals.reduce(
    (acc, f) => acc + f.text.replace(/\s/g, "").length,
    0,
  );
}
