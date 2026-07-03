/**
 * Named-view router for the app shell (app-shell).
 *
 * Hash-based (like hash-route) so vite-plugin-pwa's navigateFallback stays
 * untouched. Total parser — any unrecognised hash routes to Home, never
 * throws. Coexists with the legacy hash-route until the shell cutover.
 *
 * Routes:
 *   ""  / "#" / "#/"      -> home
 *   "#/library"           -> library
 *   "#/item/<id>"         -> detail{itemId}
 *   "#/models"            -> models
 *   "#/settings"          -> settings
 *   "#/license"           -> license
 *   anything else         -> home
 */

export type View =
  | { name: "home" }
  | { name: "library" }
  | { name: "detail"; itemId: string }
  | { name: "models" }
  | { name: "settings" }
  // fe-license-tab: License is a first-class view. The router parses its hash
  // on every surface; desktop-only gating lives in the profile/view layer.
  | { name: "license" };

const HOME: View = { name: "home" };

export function parseViewHash(hash: string): View {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (path === "" || path === "/") return HOME;
  if (path === "/library") return { name: "library" };
  if (path === "/models") return { name: "models" };
  if (path === "/settings") return { name: "settings" };
  if (path === "/license") return { name: "license" };
  if (path.startsWith("/item/")) {
    const id = path.slice("/item/".length);
    // Reject empty ("/item/") and multi-segment ("/item/a/b") ids.
    if (id === "" || id.includes("/")) return HOME;
    return { name: "detail", itemId: id };
  }
  return HOME;
}

export function viewToHash(view: View): string {
  switch (view.name) {
    case "home":
      return "#/";
    case "library":
      return "#/library";
    case "models":
      return "#/models";
    case "settings":
      return "#/settings";
    case "license":
      return "#/license";
    case "detail":
      return `#/item/${view.itemId}`;
  }
}

export function onViewChange(handler: (view: View) => void): () => void {
  // Synchronous initial fire so consumers don't miss the boot view.
  handler(parseViewHash(window.location.hash));
  const listener = () => handler(parseViewHash(window.location.hash));
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function navigateToView(view: View, opts?: { replace?: boolean }): void {
  const target = viewToHash(view);
  if (opts?.replace) {
    history.replaceState(null, "", target);
    window.dispatchEvent(new Event("hashchange"));
  } else {
    window.location.hash = target;
  }
}
