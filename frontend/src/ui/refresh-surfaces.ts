/**
 * The set of UI surfaces that must re-read their data when a capture lands or
 * the app regains visibility. Kept as one helper so every refresh path stays
 * symmetric — a background-completed capture (global hotkey on desktop,
 * external /transcribe on web) must refresh BOTH the App Shell sidebar and the
 * Home dashboard, not just one. (The legacy history rail was retired in
 * retire-v2-recording-shell.)
 */
export interface RefreshSurfaces {
  /** v3 App Shell sidebar counts + recent items. */
  shell: () => void;
  /** v3 Home dashboard recent cards + activity. */
  home: () => void;
}

/** Refresh every data surface in one call so none can be silently left stale. */
export function refreshAllSurfaces(surfaces: RefreshSurfaces): void {
  surfaces.shell();
  surfaces.home();
}
