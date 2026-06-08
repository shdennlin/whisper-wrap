/**
 * TypeScript shapes that mirror the server's MeetingResult JSON.
 *
 * Server source of truth: `app/services/meeting.py` dataclasses serialised
 * by `app/api/meeting.py::_serialise_result`. Keep these in sync.
 */

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

export interface JobError {
  code: string;
  message: string;
}

export interface JobStatusResponse {
  status: JobStatus;
  progress: number;
  stage: string;
  result: MeetingResult | null;
  error?: JobError;
}
