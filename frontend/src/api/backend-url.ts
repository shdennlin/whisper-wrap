/**
 * The ONE canonical backend-origin resolver.
 *
 * Before codegen, base-URL resolution was duplicated as local closures in
 * `main.ts` and `recording-controller.ts` (and a per-instance injected getter
 * in `history-store.ts`). This is the single function the API client's request
 * middleware reads — the migration (tasks 2.x) collapses those closures onto
 * it. Its semantics match the closures exactly:
 *
 *   - Read `loadSettings().backendUrl` fresh on EVERY call (never cache) so a
 *     settings change takes effect without a page reload.
 *   - Fall back to `window.location.origin` when the setting is empty (the
 *     same-origin default; also matches history-store's `''` → same-origin).
 *   - Strip a single trailing slash so the middleware can append request paths
 *     without a double slash.
 *
 * Returns the origin only (no path) — the client middleware prefixes it onto
 * each request's path.
 */
import { loadSettings } from "../ui/settings-panel";

export function backendUrl(): string {
  const base = loadSettings().backendUrl || window.location.origin;
  return base.replace(/\/$/, "");
}
