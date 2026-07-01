/**
 * Frontend runs client (fe-item-detail-runs). Wraps the backend run surface:
 * list an item's runs, read one, drive a stage to completion. Mirrors the
 * job-status contract + the per-run result snapshot.
 *
 * Migrated onto the generated `openapi-fetch` client (fe-api-client-codegen,
 * task 2.3): path, params, and request body are typed against the generated
 * contract, and `{ error, response }` drives the non-OK branch. The run
 * record's `result` field is the single documented dynamic exception — the
 * contract types it open (`unknown`), so it is asserted to the hand-kept
 * `RunResult` snapshot type at the one normalize boundary (`toRun`). Every
 * other field flows from the generated `RunRecord` type directly.
 */
import { client } from "../api/client";
import type { components } from "../api/generated/openapi";

export type RunStatus = components["schemas"]["RunStatus"];
export type RunKind = components["schemas"]["RunKind"];
export type RunOrigin = components["schemas"]["RunOrigin"];

/**
 * The run's immutable result snapshot, or null. Its shape is stage-dependent
 * (transcribe turns vs. an AI answer), so the contract — and this hand-kept
 * type — leaves it open; consumers narrow it at their read site.
 */
export type RunResult = unknown | null;

/**
 * A run's job-status record. Every field is the generated `RunRecord` contract
 * type except:
 *   - `origin` is relaxed to optional — an older engine may omit it, in which
 *     case it is treated as `stage` (synthesized runs are read-only).
 *   - `result` is the hand-kept `RunResult` (the documented dynamic exception).
 */
export type Run = Omit<components["schemas"]["RunRecord"], "origin" | "result"> & {
  origin?: RunOrigin;
  result: RunResult;
};

/**
 * Normalize a generated `RunRecord` into the module's `Run`. This is the ONE
 * dynamic-exception boundary: the run-record `result` field is typed open
 * (`unknown`) by the contract, so it is asserted here to the hand-kept
 * `RunResult` snapshot type (design "Cast only the documented dynamic
 * exceptions"). Every other field flows through untouched.
 */
function toRun(record: components["schemas"]["RunRecord"]): Run {
  return {
    ...record,
    // Run-record `result` dynamic exception: the contract leaves `result`
    // open/unknown; normalize to the hand-kept nullable snapshot shape.
    result: (record.result ?? null) as RunResult,
  };
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
  const { data, error, response } = await client.GET("/items/{id}/runs", {
    params: { path: { id: itemId } },
  });
  if (error || !data) throw new Error(`list runs failed: ${response.status}`);
  return data.runs.map(toRun);
}

export async function getRun(runId: string): Promise<Run> {
  const { data, error, response } = await client.GET("/runs/{id}", {
    params: { path: { id: runId } },
  });
  if (error || !data) throw new Error(`get run failed: ${response.status}`);
  return toRun(data);
}

export interface StageOpts {
  model?: string;
  quality?: string;
  prompt?: string;
}

/** Throw on a non-OK stage response; otherwise return the new run id. */
function stageRunId(
  data: components["schemas"]["RunAccepted"] | undefined,
  error: unknown,
  response: Response,
  kind: RunKind,
): string {
  if (error || !data) throw new Error(`stage ${kind} failed: ${response.status}`);
  return data.run_id;
}

/** Start a stage on an item; resolves to the new run id. */
export async function runStage(
  itemId: string,
  kind: RunKind,
  opts: StageOpts = {},
): Promise<string> {
  const path = { id: itemId };
  if (kind === "transcribe") {
    const { data, error, response } = await client.POST("/items/{id}/transcribe", {
      params: { path, query: opts.model ? { model: opts.model } : {} },
    });
    return stageRunId(data, error, response, kind);
  }
  if (kind === "diarize") {
    const { data, error, response } = await client.POST("/items/{id}/diarize", {
      params: { path, query: opts.quality ? { quality: opts.quality } : {} },
    });
    return stageRunId(data, error, response, kind);
  }
  const { data, error, response } = await client.POST("/items/{id}/ai", {
    params: { path, query: opts.model ? { model: opts.model } : {} },
    body: { prompt: opts.prompt ?? "" },
  });
  return stageRunId(data, error, response, kind);
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
