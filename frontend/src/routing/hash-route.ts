/**
 * Tiny hash-based pseudo-router for the History view.
 *
 * We use hash routing (not the History API) so vite-plugin-pwa's
 * `navigateFallback: "index.html"` stays as-is — hash fragments never reach
 * the service worker, so no route allowlist gymnastics are needed.
 *
 * Two routes:
 *   - `""` or `"#"`           → recording shell (default)
 *   - `"#/history"`           → master-detail with no selection (rail-only)
 *   - `"#/history/<id>"`      → master-detail with that session selected
 *   - anything else           → recording shell (parser is total — never throws)
 */

export type ParsedRoute =
  | { name: "shell" }
  | { name: "history"; sessionId: string | null }
  | { name: "meeting" };

const SHELL: ParsedRoute = { name: "shell" };
const MEETING: ParsedRoute = { name: "meeting" };

export function parseHash(hash: string): ParsedRoute {
  if (hash === "" || hash === "#") return SHELL;
  // Strip the leading '#'; the rest must start with a known route prefix.
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (path === "/meeting") return MEETING;
  if (path === "/history") return { name: "history", sessionId: null };
  if (!path.startsWith("/history/")) return SHELL;
  const rest = path.slice("/history/".length);
  // Reject empty id ("/history/" or "/history//") and multi-segment paths
  // ("/history/a/b") — the contract is a single id segment.
  if (rest === "" || rest.includes("/")) return SHELL;
  return { name: "history", sessionId: rest };
}

export function onRouteChange(
  handler: (route: ParsedRoute) => void,
): () => void {
  // Synchronous initial-fire so consumers don't miss the boot route.
  handler(parseHash(window.location.hash));
  const listener = () => handler(parseHash(window.location.hash));
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function navigateToHistory(
  sessionId?: string,
  opts?: { replace?: boolean },
): void {
  const target = sessionId ? `#/history/${sessionId}` : "#/history";
  if (opts?.replace) {
    // Replaces the current history entry instead of pushing a new one — used
    // after destructive ops (e.g. deleting the session you're viewing) so a
    // subsequent Back button doesn't return to the now-stale URL. Manual
    // hashchange dispatch is required because replaceState doesn't fire one.
    history.replaceState(null, "", target);
    window.dispatchEvent(new Event("hashchange"));
  } else {
    window.location.hash = target;
  }
}
