/**
 * Persists the Meeting Mode transcript view preference to localStorage.
 *
 * Default is "chat" — collapsed-by-speaker bubbles are dramatically more
 * compact for long meetings (typically 3-5× shorter for natural
 * conversation) and read more naturally than a flat list of per-VAD
 * segments. Users who need timestamp-per-segment precision (subtitle
 * editing, fine-grained corrections) can swap to "detail" any time.
 */

export type MeetingViewMode = "detail" | "chat";

export const MEETING_VIEW_MODE_KEY = "whisper-wrap.meeting-view-mode.v1";
export const DEFAULT_MEETING_VIEW_MODE: MeetingViewMode = "chat";

export function loadMeetingViewMode(): MeetingViewMode {
  try {
    const raw = window.localStorage.getItem(MEETING_VIEW_MODE_KEY);
    return raw === "detail" || raw === "chat"
      ? raw
      : DEFAULT_MEETING_VIEW_MODE;
  } catch {
    // localStorage can throw in private-browsing / iframe contexts;
    // fall back to the default rather than breaking the page.
    return DEFAULT_MEETING_VIEW_MODE;
  }
}

export function saveMeetingViewMode(mode: MeetingViewMode): void {
  try {
    window.localStorage.setItem(MEETING_VIEW_MODE_KEY, mode);
  } catch {
    // Silent — not critical to the UI working.
  }
}
