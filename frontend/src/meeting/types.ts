/**
 * TypeScript shapes for Meeting Mode.
 *
 * `Word`/`Segment`/`MeetingResult` describe the diarization result payload,
 * which the engine keeps as a dynamic `serde_json::Value` in the generated
 * contract (typed `unknown`); they are the frontend's concrete refinement of
 * that dynamic shape and are NOT superseded by codegen, so they stay
 * hand-written here. `JobStatus` and `JobStatusResponse` are the frontend view
 * of the meeting job-status body — derived from the generated contract but
 * narrowing the fields the frontend refines (see below).
 */

import type { components } from "../api/generated/openapi";

export interface Word {
  word: string;
  start: number;
  end: number;
}

export interface Segment {
  speaker: string;
  start: number;
  end: number;
  text: string;
  words?: Word[];
}

export interface MeetingResult {
  language: string;
  duration_seconds: number;
  speakers: string[];
  segments: Segment[];
}

export type JobStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cancelled";

/**
 * Frontend view of the meeting job-status body (`GET /transcribe/meeting/{id}`).
 *
 * Derived from the generated `PollResponse` so the static fields (`progress`,
 * `stage`, `error`) track the contract, but narrows the two fields the frontend
 * refines over it:
 *   - `status` → the {@link JobStatus} union (the contract types it as a bare
 *     `string`).
 *   - `result` → the concrete {@link MeetingResult} | null (the contract keeps
 *     `result` as dynamic `serde_json::Value`, i.e. `unknown`).
 * `error` reuses the generated `PollError` (`{ code, message }`).
 */
export type JobStatusResponse = Omit<
  components["schemas"]["PollResponse"],
  "status" | "result"
> & {
  status: JobStatus;
  result: MeetingResult | null;
};
