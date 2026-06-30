/**
 * Frontend runs client (fe-item-detail-runs). Wraps the backend run surface:
 * list an item's runs, read one, drive a stage to completion. Mirrors the
 * job-status contract + the per-run result snapshot.
 */

export type RunStatus = "queued" | "running" | "done" | "error" | "cancelled";
export type RunKind = "transcribe" | "diarize" | "ai";
/**
 * Provenance of a run in the unified listing (unify-run-ledger): `stage` is a
 * real ledger run; `capture`/`legacy` are read-only runs the backend
 * synthesizes from a session's finals / legacy action_runs. Absent is treated
 * as `stage` (an older engine omits the field).
 */
export type RunOrigin = "stage" | "capture" | "legacy";

export interface Run {
  id: string;
  item_id: string;
  kind: RunKind;
  model: string | null;
  status: RunStatus;
  progress: number;
  stage: string | null;
  result_ref: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  /** Immutable per-run result snapshot, or null. */
  result: unknown | null;
  /** Provenance; absent → treat as `stage` (synthesized runs are read-only). */
  origin?: RunOrigin;
}

/** True when a run is a read-only synthesized run (no re-run / delete). */
export function isReadOnlyRun(run: Pick<Run, "origin">): boolean {
  return run.origin === "capture" || run.origin === "legacy";
}

export function isTerminal(status: RunStatus): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

/** Every run recorded against an item (oldest first). */
export async function listItemRuns(itemId: string): Promise<Run[]> {
  const r = await fetch(`/items/${encodeURIComponent(itemId)}/runs`);
  if (!r.ok) throw new Error(`list runs failed: ${r.status}`);
  const d = (await r.json()) as { runs: Run[] };
  return d.runs;
}

export async function getRun(runId: string): Promise<Run> {
  const r = await fetch(`/runs/${encodeURIComponent(runId)}`);
  if (!r.ok) throw new Error(`get run failed: ${r.status}`);
  return (await r.json()) as Run;
}

export interface StageOpts {
  model?: string;
  quality?: string;
  prompt?: string;
}

/** Start a stage on an item; resolves to the new run id. */
export async function runStage(
  itemId: string,
  kind: RunKind,
  opts: StageOpts = {},
): Promise<string> {
  const params = new URLSearchParams();
  if (opts.model) params.set("model", opts.model);
  if (opts.quality) params.set("quality", opts.quality);
  const qs = params.toString();
  const url = `/items/${encodeURIComponent(itemId)}/${kind}${qs ? `?${qs}` : ""}`;

  const init: RequestInit = { method: "POST" };
  if (kind === "ai") {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify({ prompt: opts.prompt ?? "" });
  }
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`stage ${kind} failed: ${r.status}`);
  const d = (await r.json()) as { run_id: string };
  return d.run_id;
}

/** Poll a run to a terminal state, reporting each update. */
export async function pollRun(
  runId: string,
  onUpdate?: (run: Run) => void,
  opts?: { intervalMs?: number; tries?: number },
): Promise<Run> {
  const intervalMs = opts?.intervalMs ?? 500;
  const tries = opts?.tries ?? 120;
  let run = await getRun(runId);
  onUpdate?.(run);
  for (let i = 0; i < tries && !isTerminal(run.status); i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    run = await getRun(runId);
    onUpdate?.(run);
  }
  return run;
}
