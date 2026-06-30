/**
 * Fixture data for the mocked Playwright project (fe-e2e-playwright).
 *
 * JSON-shaped objects mirroring the backend response bodies the frontend
 * consumes on load. Kept as a typed TS module (not raw .json) so specs import
 * with type safety and no resolveJsonModule config.
 */

export interface FinalRow {
  session_id: string;
  ord: number;
  text: string;
  start_ms: number | null;
  end_ms: number | null;
  kind: string | null;
}

export interface SessionFull {
  id: string;
  started_at: number;
  ended_at: number | null;
  mode: string;
  audio_path: string | null;
  audio_mime_type: string | null;
  audio_size_bytes: number | null;
  duration_ms: number | null;
  title: string | null;
  starred: boolean;
  project: string | null;
  category: string | null;
  finals: FinalRow[];
  action_runs: unknown[];
}

// A fixed base time so date rendering is deterministic across runs.
const T = 1_718_000_000_000;

export const SESSIONS: SessionFull[] = [
  {
    id: "sess-001",
    started_at: T,
    ended_at: T + 5_000,
    mode: "batch",
    audio_path: null,
    audio_mime_type: null,
    audio_size_bytes: null,
    duration_ms: 5_000,
    title: "Standup notes",
    starred: false,
    project: null,
    category: "quick",
    finals: [
      {
        session_id: "sess-001",
        ord: 0,
        text: "Let's ship the overlay improvements today",
        start_ms: 0,
        end_ms: 2_500,
        kind: "final",
      },
      {
        session_id: "sess-001",
        ord: 1,
        text: "and write the end to end tests",
        start_ms: 2_500,
        end_ms: 5_000,
        kind: "final",
      },
    ],
    action_runs: [],
  },
  {
    id: "sess-002",
    started_at: T - 86_400_000,
    ended_at: T - 86_400_000 + 3_000,
    mode: "batch",
    audio_path: null,
    audio_mime_type: null,
    audio_size_bytes: null,
    duration_ms: 3_000,
    title: "Quick idea",
    starred: true,
    project: "v3",
    category: "quick",
    finals: [],
    action_runs: [],
  },
];

export const MEETINGS: unknown[] = [];

export const ACTIONS: unknown[] = [];

// loaded: true so the first-run gate (shown only when no model is loaded)
// stays out of the way for the mocked UI flows.
export const STATUS = {
  ok: true,
  model: { name: "breeze-asr-25", loaded: true },
};

export const MODELS = {
  active: "breeze-asr-25",
  models: [
    {
      name: "breeze-asr-25",
      description: "test",
      installed: false,
      active: true,
    },
  ],
};
