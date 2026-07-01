/**
 * Item Detail view + run inspector (fe-item-detail-runs, layout fe-visual-polish).
 *
 * Where the Item/Runs model becomes visible: an item's runs grouped by kind
 * (transcribe / diarize / ai), every version kept and switchable, with re-run
 * controls that append a new run. DAG capability gating: the AI stage is
 * disabled until a completed transcribe run exists.
 *
 * Layout (mockup document + inspector rail): `.detail-wrap` holds a `.doc`
 * column (title row, `.meta` badges, transcript turns or raw snapshot) and an
 * `aside.inspector` rail (run groups, re-run buttons, `.askbar`). A floating
 * `.player` capsule mounts only when the item's audio loads. CSS lands in a
 * later task — classes only here.
 */

import {
  isReadOnlyRun,
  listItemRuns,
  pollRun,
  runStage,
  type Run,
  type RunKind,
} from "../library/runs-api";
import {
  openAiActionModal,
} from "./ai-action-modal";
import type {
  ActionTemplate,
  ActionsResponse,
  Category,
} from "./actions-bar";
import { navigateToView } from "../routing/view-route";
import {
  deleteSession,
  getAudio,
  getSession,
  type SessionFull,
} from "../storage/history-api-client";
import { deleteMeeting } from "../meeting/meeting-history-api";
import { listItems } from "../library/items";
import { modalConfirm } from "./modal-prompt";
import { toast } from "./toast";
import { t, type StringKey } from "../i18n";
import { WaveformPlayer, type PlayerInput } from "./waveform-player";
import { client } from "../api/client";

const KINDS: RunKind[] = ["transcribe", "diarize", "ai"];

/** User-facing labels — the raw run kinds/statuses are internal jargon. */
const KIND_LABEL: Record<RunKind, StringKey> = {
  transcribe: "detail.kindTranscribe",
  diarize: "detail.kindDiarize",
  ai: "detail.kindAi",
};
const STATUS_LABEL: Record<string, StringKey> = {
  pending: "detail.statusPending",
  running: "detail.statusRunning",
  done: "detail.statusDone",
  error: "detail.statusError",
};
const kindLabel = (k: RunKind): string => (KIND_LABEL[k] ? t(KIND_LABEL[k]) : k);
const statusLabel = (s: string): string => (STATUS_LABEL[s] ? t(STATUS_LABEL[s]) : s);

/** Delete an item by resolving its kind (session vs meeting) from the unified
 *  list, then calling the matching DELETE endpoint. Both deletes are
 *  idempotent on 404. */
async function defaultDeleteItem(itemId: string): Promise<void> {
  const items = await listItems();
  const item = items.find((i) => i.id === itemId);
  if (item?.kind === "meeting") await deleteMeeting(itemId);
  else await deleteSession(itemId);
}

export interface AiStatus {
  configured: boolean;
  provider: string;
  endpoint: string;
}

export interface DetailDeps {
  loadRuns?: (itemId: string) => Promise<Run[]>;
  startStage?: (
    itemId: string,
    kind: RunKind,
    opts?: { quality?: string; prompt?: string },
  ) => Promise<string>;
  /** The AI privacy indicator (provider + endpoint) — from `/status` `ai`. */
  loadAiStatus?: () => Promise<AiStatus>;
  /** Hook fired after a stage is started (e.g. to begin polling). */
  onRunStarted?: (kind: RunKind) => void;
  /** Audio source for the floating player capsule — overridable for tests. */
  loadAudio?: (itemId: string) => Promise<Blob>;
  /** Delete the item (kind-resolved); overridable for tests. */
  deleteItem?: (itemId: string) => Promise<void>;
  /** Load the session (for its finals transcript) when there are no runs to
   *  show; overridable for tests. Returns null for non-sessions / on failure. */
  loadSession?: (itemId: string) => Promise<SessionFull | null>;
  /** Load the AI action templates for the picker modal; overridable for tests. */
  loadActions?: () => Promise<ActionsResponse>;
}

async function defaultLoadActions(): Promise<ActionsResponse> {
  const { data, error, response } = await client.GET("/actions");
  const status = response.status;
  if (error || !data) throw new Error(`HTTP ${status}`);
  // The contract types `/actions` arrays as `unknown[]` (their elements are
  // `serde_json::Value` in core, deliberately not over-typed). Map to the
  // frontend Action/Category shapes at this boundary. This is a contract-loose
  // array mapping, NOT one of the documented dynamic-exception response casts
  // (those live in `src/api/ai-config.ts`).
  return {
    actions: (data.actions ?? []) as ActionTemplate[],
    categories: (data.categories ?? []) as Category[],
  };
}

async function defaultLoadAiStatus(): Promise<AiStatus> {
  const { data } = await client.GET("/status");
  return data?.ai ?? { configured: false, provider: "", endpoint: "" };
}

async function defaultLoadAudio(itemId: string): Promise<Blob> {
  const audio = await getAudio(itemId);
  if (!audio) throw new Error("no audio stored for item");
  return audio.blob;
}

/** The waveform player mounted per container — destroyed on re-render so its
 *  internal object URL + listeners are released. */
const detailPlayers = new WeakMap<HTMLElement, WaveformPlayer>();

/** Human display title for the detail header: explicit title, else a time
 *  label from the capture time — never the raw backend id (it reads as noise). */
function deriveTitle(session: SessionFull | null, itemId: string): string {
  if (session?.title) return session.title;
  const ts = session?.started_at;
  if (ts != null) {
    const d = new Date(ts < 1e12 ? ts * 1000 : ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return t("detail.titleTime", {
      m: d.getMonth() + 1,
      d: d.getDate(),
      hh,
      mm,
    });
  }
  return itemId;
}

interface TurnEntry {
  text: string;
  speaker: string | null;
  start: number | null;
}

/**
 * Pull speaker-turn entries out of a run snapshot. Accepts the segment shapes
 * the backends emit (`segments` or `turns` arrays whose entries carry `text`,
 * optionally `speaker` + `start`). Returns null when the snapshot isn't
 * segment-shaped so the caller falls back to raw rendering.
 */
function turnEntries(result: unknown): TurnEntry[] | null {
  const r = result as { segments?: unknown; turns?: unknown } | null;
  const raw = Array.isArray(r?.segments)
    ? r.segments
    : Array.isArray(r?.turns)
      ? r.turns
      : null;
  if (!raw) return null;
  const entries = raw.flatMap((e: unknown): TurnEntry[] => {
    if (typeof e !== "object" || e === null) return [];
    const seg = e as { text?: unknown; speaker?: unknown; start?: unknown };
    if (typeof seg.text !== "string") return [];
    return [
      {
        text: seg.text,
        speaker: typeof seg.speaker === "string" ? seg.speaker : null,
        start: typeof seg.start === "number" ? seg.start : null,
      },
    ];
  });
  return entries.length ? entries : null;
}

/** Stable hash of a speaker label onto 3 colour buckets (c1 / c2 / c3). */
function speakerBucket(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) {
    h = (h * 31 + label.charCodeAt(i)) >>> 0;
  }
  return `c${(h % 3) + 1}`;
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function timestampEl(start: number): HTMLElement {
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = formatTimestamp(start);
  return t;
}

function turnEl(entry: TurnEntry): HTMLElement {
  const turn = document.createElement("div");
  turn.className = "turn";
  if (entry.speaker) {
    turn.classList.add(speakerBucket(entry.speaker));
    const who = document.createElement("div");
    who.className = "who";
    who.append(document.createTextNode(entry.speaker));
    if (entry.start != null) who.appendChild(timestampEl(entry.start));
    turn.appendChild(who);
  } else if (entry.start != null) {
    turn.appendChild(timestampEl(entry.start));
  }
  const p = document.createElement("p");
  p.textContent = entry.text;
  turn.appendChild(p);
  return turn;
}

export async function renderDetail(
  container: HTMLElement,
  itemId: string,
  deps: DetailDeps = {},
): Promise<void> {
  const loadRuns = deps.loadRuns ?? listItemRuns;
  const startStage =
    deps.startStage ?? ((id, kind, opts) => runStage(id, kind, opts));
  const loadAudio = deps.loadAudio ?? defaultLoadAudio;
  const deleteItem = deps.deleteItem ?? defaultDeleteItem;
  const loadActions = deps.loadActions ?? defaultLoadActions;
  const loadSession =
    deps.loadSession ?? ((id: string) => getSession(id).catch(() => null));

  container.replaceChildren();
  container.classList.add("detail-view");

  const previousPlayer = detailPlayers.get(container);
  if (previousPlayer) {
    previousPlayer.destroy();
    detailPlayers.delete(container);
  }

  // Kick off the audio fetch in parallel with the run load; the player only
  // mounts if it succeeds.
  const audioPromise: Promise<Blob | null> = (async () => {
    try {
      return await loadAudio(itemId);
    } catch {
      return null;
    }
  })();

  const wrap = document.createElement("div");
  wrap.className = "detail-wrap";

  // Document column: title row, metadata badges, transcript content.
  const doc = document.createElement("div");
  doc.className = "doc";
  const header = document.createElement("div");
  header.className = "detail-header";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "detail-back";
  back.textContent = t("detail.backToLibrary");
  back.addEventListener("click", () => navigateToView({ name: "library" }));
  const title = document.createElement("div");
  title.className = "detail-title";
  // Placeholder until the session loads; never leave the raw id as the title
  // (ids read as noise) — it's replaced with the title / a time label below.
  title.textContent = "…";
  // Delete: confirm via the WKWebView-safe modal (native confirm() is broken
  // in the Tauri shell), then delete and return to the Library.
  const del = document.createElement("button");
  del.type = "button";
  del.className = "detail-delete";
  del.textContent = t("detail.delete");
  del.addEventListener("click", async () => {
    const ok = await modalConfirm(t("detail.deleteConfirm"), {
      okLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    del.disabled = true;
    try {
      await deleteItem(itemId);
      navigateToView({ name: "library" });
    } catch (e) {
      del.disabled = false;
      toast(t("detail.deleteFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
  });
  header.append(back, title, del);

  const meta = document.createElement("div");
  meta.className = "meta";
  const snapshot = document.createElement("div");
  snapshot.className = "run-snapshot";
  doc.append(header, meta, snapshot);

  // Inspector rail: run groups, re-run buttons, Ask-AI bar.
  const rail = document.createElement("aside");
  rail.className = "inspector";
  const runsHeader = document.createElement("h4");
  runsHeader.textContent = t("detail.runsHeader");
  const inspector = document.createElement("div");
  inspector.className = "run-inspector";
  const actionsHeader = document.createElement("h4");
  actionsHeader.textContent = t("detail.rerunHeader");
  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const askbar = document.createElement("div");
  askbar.className = "askbar";
  rail.append(runsHeader, inspector, actionsHeader, actions, askbar);

  wrap.append(doc, rail);
  container.append(wrap);

  let runs = await loadRuns(itemId);
  // The session supplies the header title and the audio player's metadata. The
  // transcript itself is no longer read from `session.finals` here — the
  // backend synthesizes a capture transcribe run from finals (unify-run-ledger)
  // so the runs list is the single source for everything in the inspector.
  const session = await loadSession(itemId).catch(() => null);
  title.textContent = deriveTitle(session, itemId);
  const aiStatus = await (deps.loadAiStatus ?? defaultLoadAiStatus)().catch(
    () => ({ configured: false, provider: "", endpoint: "" }) as AiStatus,
  );

  // AI is unlocked by a completed transcribe run. A quick capture's finals
  // arrive as a synthesized capture transcribe run, so this one check covers
  // captures too — no session-finals special-case.
  const hasTranscript = () =>
    runs.some((r) => r.kind === "transcribe" && r.status === "done");

  function renderMeta(run: Run): void {
    meta.replaceChildren();
    const parts = [
      kindLabel(run.kind),
      statusLabel(run.status),
      ...(run.model ? [run.model] : []),
    ];
    for (const text of parts) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = text;
      meta.appendChild(badge);
    }
  }

  function showSnapshot(run: Run): void {
    snapshot.replaceChildren();
    snapshot.dataset.runId = run.id;
    renderMeta(run);
    if (run.status === "error") {
      const body = document.createElement("pre");
      body.className = "snapshot-body";
      body.textContent = run.error ?? "error";
      snapshot.appendChild(body);
      return;
    }
    const entries = turnEntries(run.result);
    if (entries) {
      for (const entry of entries) snapshot.appendChild(turnEl(entry));
      return;
    }
    // Not segment-shaped — keep the raw snapshot fallback.
    const body = document.createElement("pre");
    body.className = "snapshot-body";
    body.textContent = JSON.stringify(run.result ?? null, null, 2);
    snapshot.appendChild(body);
  }

  function selectRun(run: Run): void {
    for (const el of inspector.querySelectorAll<HTMLElement>(".run-row")) {
      el.classList.toggle("active", el.dataset.runId === run.id);
    }
    showSnapshot(run);
  }

  function renderInspector(): void {
    inspector.replaceChildren();
    for (const kind of KINDS) {
      const group = runs.filter((r) => r.kind === kind);
      if (!group.length) continue;
      const g = document.createElement("div");
      g.className = "run-group";
      g.dataset.kind = kind;
      const h = document.createElement("div");
      h.className = "run-group-title";
      h.textContent = kindLabel(kind);
      g.appendChild(h);
      group.forEach((run, idx) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "run-row";
        row.dataset.runId = run.id;
        row.dataset.kind = kind;
        // Provenance (unify-run-ledger): `capture`/`legacy` runs are synthesized
        // and read-only — flagged so they get no re-run/delete affordance and
        // can be styled apart. Absent origin from an older engine reads `stage`.
        row.dataset.origin = run.origin ?? "stage";
        if (isReadOnlyRun(run)) row.classList.add("read-only");
        // Oldest-first from the backend; #N labels the version.
        row.textContent = `#${idx + 1} · ${statusLabel(run.status)}`;
        row.addEventListener("click", () => selectRun(run));
        g.appendChild(row);
      });
      inspector.appendChild(g);
    }
  }

  function selectLatest(): boolean {
    // Prefer the latest transcript, else the latest run of any kind.
    for (const kind of ["transcribe", "diarize", "ai"] as RunKind[]) {
      const group = runs.filter((r) => r.kind === kind);
      if (group.length) {
        selectRun(group[group.length - 1]);
        return true;
      }
    }
    return false;
  }

  /** No runs at all (real or synthesized) → the item has no transcript yet. */
  function showEmpty(): void {
    snapshot.replaceChildren();
    meta.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "snapshot-empty";
    empty.textContent = t("detail.noTranscript");
    snapshot.appendChild(empty);
  }

  /** Re-run a transcribe/diarize stage and refresh the inspector. Both stages
   *  process the item's STORED AUDIO, so they're disabled when no recording was
   *  saved (the engine would 409). On run, the inspector shows the running run,
   *  then polls to completion so the finished result replaces the placeholder;
   *  failures surface as a toast instead of silently re-enabling the button. */
  function rerunButton(kind: "transcribe" | "diarize"): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stage-btn";
    btn.dataset.kind = kind;
    btn.textContent = t("detail.rerunKind", { kind: kindLabel(kind) });
    // No stored audio → nothing to re-run on. Disable with a reason rather than
    // letting the click silently 409 (quick captures with audio-save off).
    if (session?.audio_path == null) {
      btn.disabled = true;
      btn.title = t("detail.rerunNeedsAudio");
      btn.dataset.disabledReason = "no-audio";
      return btn;
    }
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        // Omit quality — the engine resolves an installed tier
        // (default_installed). Hardcoding "fast" 503s on a balanced-only install.
        const runId = await startStage(itemId, kind, {});
        deps.onRunStarted?.(kind);
        // Show the running run immediately…
        runs = await loadRuns(itemId);
        renderInspector();
        renderActions();
        selectLatest();
        // …then poll so the finished (or errored) run replaces it.
        const done = await pollRun(runId);
        if (done.status === "error") {
          toast(t("detail.rerunFailed", { error: done.error ?? "error" }));
        }
        runs = await loadRuns(itemId);
        renderInspector();
        renderActions();
        selectLatest();
      } catch (e) {
        btn.disabled = false;
        toast(
          t("detail.rerunFailed", {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    });
    return btn;
  }

  /** Run a picked AI instruction through the ai stage, poll it to completion,
   *  refresh the inspector so the new run appears, and resolve to its answer.
   *  Throws on failure so the picker surfaces a localised error. */
  async function runAi(instruction: string): Promise<string> {
    const runId = await startStage(itemId, "ai", { prompt: instruction });
    deps.onRunStarted?.("ai");
    const done = await pollRun(runId);
    runs = await loadRuns(itemId);
    renderInspector();
    renderActions();
    const answer = (done.result as { answer?: string } | null)?.answer;
    if (typeof answer !== "string") throw new Error(done.error ?? "ai run failed");
    return answer;
  }

  function renderActions(): void {
    actions.replaceChildren();
    askbar.replaceChildren();
    actions.append(rerunButton("transcribe"), rerunButton("diarize"));

    // AI lives in the askbar and opens the categorised action-picker modal
    // (each pick is recorded as an ai run). DAG gate: needs a transcript.
    const aiBtn = document.createElement("button");
    aiBtn.type = "button";
    aiBtn.className = "stage-btn ai-open";
    aiBtn.dataset.kind = "ai";
    aiBtn.textContent = t("detail.aiEnhance");
    if (!hasTranscript()) {
      aiBtn.disabled = true;
      aiBtn.title = t("detail.aiGateNeedsTranscript");
      aiBtn.dataset.disabledReason = "no-transcript";
    }
    aiBtn.addEventListener("click", () =>
      openAiActionModal({
        loadActions,
        runAi,
        model: {
          configured: aiStatus.configured,
          model: aiStatus.provider || undefined,
        },
      }),
    );
    askbar.appendChild(aiBtn);
  }

  renderActions();
  renderInspector();
  // selectLatest prefers the latest transcribe run, so a capture-only item now
  // defaults to showing its transcript (not the raw AI JSON). Empty → a hint.
  if (!selectLatest()) showEmpty();

  // Floating player capsule — the waveform "voice bar", only when audio loads.
  const blob = await audioPromise;
  if (blob) {
    const host = document.createElement("div");
    host.className = "player";
    const input: PlayerInput = {
      kind: "audio",
      blob,
      mime_type: session?.audio_mime_type ?? blob.type ?? "audio/webm",
      duration_ms: session?.duration_ms ?? 0,
    };
    const player = new WaveformPlayer({ root: host, input });
    detailPlayers.set(container, player);
    void player.load();
    wrap.appendChild(host);
  }
}
