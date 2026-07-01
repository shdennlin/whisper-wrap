/**
 * Unified Item model (fe-item-library).
 *
 * The Library presents sessions and meetings as one list of `Item`s. The
 * backend keeps them in separate tables (item-metadata adds title/starred/
 * project/category to both); this merges the two list endpoints client-side
 * into a newest-first item list. Capabilities follow the data, not the kind.
 */

import {
  listSessions,
  type SessionFull,
} from "../storage/history-api-client";
import { listMeetings, type MeetingFull } from "../meeting/meeting-history-api";

export type ItemKind = "session" | "meeting";

export interface Item {
  id: string;
  kind: ItemKind;
  title: string | null;
  starred: boolean;
  project: string | null;
  category: string | null;
  /** Unix-ish creation time used for newest-first ordering. */
  createdAt: number;
  durationMs: number | null;
  /** Meeting display filename, when present. */
  filename?: string;
  /** First few detected words — a glance preview for list rows. Empty when
   *  the transcript isn't loaded with the list row (e.g. meetings). */
  preview?: string;
}

/** A short single-line preview from a session's final segments: the leading
 *  words, trimmed and capped so sidebar rows stay one line. */
const PREVIEW_MAX = 48;
function sessionPreview(
  finals: SessionFull["finals"] | undefined,
): string | undefined {
  if (!finals || finals.length === 0) return undefined;
  const text = finals
    .map((f) => f.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

/** Human display title: explicit title, else filename, else a time-based
 *  label — never the raw backend id (ids read as noise in lists). */
export function itemDisplayTitle(item: Item): string {
  if (item.title) return item.title;
  if (item.filename) return item.filename;
  const d = new Date(item.createdAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `🎙 ${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function sessionToItem(s: SessionFull): Item {
  return {
    id: s.id,
    kind: "session",
    title: s.title ?? null,
    starred: Boolean(s.starred),
    project: s.project ?? null,
    category: s.category ?? null,
    createdAt: s.started_at,
    durationMs: s.duration_ms ?? null,
    preview: sessionPreview(s.finals),
  };
}

function meetingToItem(m: MeetingFull): Item {
  return {
    id: m.id,
    kind: "meeting",
    // A meeting's title falls back to its filename when unset.
    title: m.title ?? m.filename ?? null,
    starred: Boolean(m.starred),
    project: m.project ?? null,
    // Meetings default to the "meeting" category when unset.
    category: m.category ?? "meeting",
    createdAt: m.created_at,
    durationMs:
      m.duration_seconds != null ? Math.round(m.duration_seconds * 1000) : null,
    filename: m.filename,
  };
}

export interface ListItemsOpts {
  backendUrl?: string;
  limit?: number;
}

/** Fetch sessions + meetings and merge them into one newest-first item list.
 *  A failure on either source degrades to the other rather than blanking. */
export async function listItems(opts: ListItemsOpts = {}): Promise<Item[]> {
  const limit = opts.limit ?? 100;

  const [sessions, meetings] = await Promise.all([
    listSessions({ limit })
      .then((r) => r.sessions)
      .catch(() => []),
    listMeetings({ limit })
      .then((r) => r.meetings)
      .catch(() => []),
  ]);

  const items = [
    ...sessions.map(sessionToItem),
    ...meetings.map(meetingToItem),
  ];
  items.sort((a, b) => b.createdAt - a.createdAt);
  return items;
}
