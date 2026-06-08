/**
 * Human-readable duration label — used by Meeting Mode's confirm card and
 * the Batch ModeCard's file-upload confirm view. Kept locale-neutral on
 * purpose (the suffixes "s"/"m"/"h" stay identical across en + zh-TW so
 * the user doesn't have to mentally re-parse the timer when switching
 * languages). If we ever need full localisation, swap callers to a richer
 * i18n key.
 */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
