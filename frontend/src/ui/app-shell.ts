/**
 * App-shell scaffold (app-shell): the macOS-native chrome every view mounts
 * into — a custom toolbar (traffic-light inset, search/⌘K affordance, model
 * pill) and a vibrancy sidebar (one nav item per top-level view) wrapping a
 * main view container.
 *
 * It owns navigation only: it subscribes to the view router, reflects the
 * active view in the sidebar, and renders the matching view into the
 * container via an overridable `renderView` (placeholder bodies by default).
 * The real view bodies are injected by the per-view sub-changes; this change
 * does NOT wire the shell into the app root (that lands with fe-item-library).
 */

import {
  navigateToView,
  onViewChange,
  viewToHash,
  type View,
} from "../routing/view-route";
import { t } from "../i18n";

// Canonical nav registry: Home/Library up top, Models/Settings pinned at the
// bottom past a spacer (mockup sidebar layout). The visible subset and order
// come from the surface profile's `nav` (Models is absent on the web surface);
// filtering the registry keeps the canonical order regardless of the profile
// array's order.
type NavName = Extract<View["name"], "home" | "library" | "models" | "settings">;
const NAV_REGISTRY: { view: View; label: string; section: "top" | "bottom" }[] = [
  { view: { name: "home" }, label: "Home", section: "top" },
  { view: { name: "library" }, label: "Library", section: "top" },
  { view: { name: "models" }, label: "Models", section: "bottom" },
  { view: { name: "settings" }, label: "Settings", section: "bottom" },
];
const DEFAULT_NAV: NavName[] = ["home", "library", "models", "settings"];

export interface SidebarSummary {
  counts: { library: number; starred: number };
  recent: { id: string; title: string; hint: string; preview?: string }[];
}

export interface AppShellDeps {
  /** Render a view's body into the container. Defaults to a placeholder so the
   *  shell is testable before the real views exist. */
  renderView?: (view: View, container: HTMLElement) => void;
  /** Subscribe to recording state; returns an unsubscribe. When provided, the
   *  shell shows a REC pill in the toolbar while a recording is active. */
  recordingState?: (
    cb: (s: { active: boolean; elapsedLabel: string }) => void,
  ) => () => void;
  /** Item summary for the enriched sidebar (counts + recent items). Absent or
   *  failing → the plain nav renders, no error surface. */
  sidebarSummary?: () => Promise<SidebarSummary>;
  /** Activate the ⭐ sidebar entry; defaults to plain Library navigation.
   *  main.ts injects a version that opens the Library star-filtered. */
  onStarredNav?: () => void;
  /** Visible nav items, in surface-profile order. Omitted → the full nav
   *  (home, library, models, settings) so the shell is usable standalone. */
  nav?: View["name"][];
}

function defaultRenderView(view: View, container: HTMLElement): void {
  container.replaceChildren();
  const ph = document.createElement("div");
  ph.className = "view-placeholder";
  ph.dataset.view = view.name;
  ph.textContent = view.name === "detail" ? `Item ${view.itemId}` : view.name;
  container.appendChild(ph);
}

export function mountAppShell(
  root: HTMLElement,
  deps: AppShellDeps = {},
): { destroy(): void; refresh(): void } {
  const renderView = deps.renderView ?? defaultRenderView;

  root.classList.add("app-shell");
  root.replaceChildren();

  // --- toolbar ---
  const toolbar = document.createElement("header");
  toolbar.className = "shell-toolbar";
  // Window-drag region for the Tauri overlay title bar (fe-macos-vibrancy).
  // Inert in plain browsers; Tauri only drags on direct hits of this element,
  // so the toolbar's interactive children keep working.
  toolbar.setAttribute("data-tauri-drag-region", "");
  const trafficInset = document.createElement("div");
  trafficInset.className = "traffic-inset"; // reserve space for macOS lights
  // The drag handler only fires on DIRECT hits of an attributed element, so
  // the inset (the most natural grab spot) needs its own marker.
  trafficInset.setAttribute("data-tauri-drag-region", "");
  const search = document.createElement("button");
  search.className = "search";
  search.type = "button";
  const searchLabel = document.createElement("span");
  searchLabel.textContent = "Search";
  const kbd = document.createElement("kbd");
  kbd.textContent = "⌘K";
  search.append(searchLabel, kbd);
  const modelPill = document.createElement("div");
  modelPill.className = "pill model-pill";
  modelPill.textContent = "—";
  toolbar.append(trafficInset, search, modelPill);

  // --- sidebar ---
  const sidebar = document.createElement("nav");
  sidebar.className = "shell-sidebar";
  // The sidebar's empty space is a natural window grab spot in macOS apps;
  // direct hits on the nav background (not its children) drag the window.
  sidebar.setAttribute("data-tauri-drag-region", "");
  const navItems = new Map<string, HTMLElement>();
  function navEl(view: View, label: string): HTMLAnchorElement {
    const a = document.createElement("a");
    a.className = "nav-item";
    a.href = viewToHash(view);
    a.dataset.view = view.name;
    a.textContent = label;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      navigateToView(view);
    });
    navItems.set(view.name, a);
    return a;
  }
  const spacer = document.createElement("div");
  spacer.className = "spacer";
  // The big empty region below the nav — same drag affordance as the sidebar.
  spacer.setAttribute("data-tauri-drag-region", "");
  const navSet = new Set<View["name"]>(deps.nav ?? DEFAULT_NAV);
  const visibleNav = NAV_REGISTRY.filter((n) => navSet.has(n.view.name));
  sidebar.append(
    ...visibleNav
      .filter((n) => n.section === "top")
      .map(({ view, label }) => navEl(view, label)),
    spacer,
    ...visibleNav
      .filter((n) => n.section === "bottom")
      .map(({ view, label }) => navEl(view, label)),
  );

  // Enriched sidebar (fe-visual-polish): counts + recent items when the
  // summary source resolves; plain nav otherwise.
  let shellDestroyed = false;
  // Remove the previously-rendered counts/⭐/recents so the summary can be
  // re-applied after items change (e.g. a delete) without duplicating.
  function clearSummary(): void {
    navItems.get("library")?.querySelector("small")?.remove();
    sidebar
      .querySelectorAll(".starred-nav, .sec, .recent")
      .forEach((el) => el.remove());
  }
  function applySummary(s: SidebarSummary): void {
    clearSummary();
    const small = (n: number): HTMLElement => {
      const el = document.createElement("small");
      el.textContent = String(n);
      return el;
    };
    navItems.get("library")?.appendChild(small(s.counts.library));

    // ⭐ entry mirrors the mockup: it routes to the Library (where the star
    // filter lives) — presentation, not a new route.
    const starred = document.createElement("a");
    starred.className = "nav-item starred-nav";
    starred.href = viewToHash({ name: "library" });
    starred.append("⭐ ", small(s.counts.starred));
    starred.addEventListener("click", (e) => {
      e.preventDefault();
      if (deps.onStarredNav) deps.onStarredNav();
      else navigateToView({ name: "library" });
    });
    navItems.get("library")?.after(starred);

    if (s.recent.length > 0) {
      const sec = document.createElement("div");
      sec.className = "sec";
      sec.textContent = t("home.recentTitle");
      const recents = s.recent.map((r) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "recent";
        const title = document.createElement("b");
        title.textContent = r.title;
        const hint = document.createElement("span");
        hint.textContent = r.hint;
        btn.append(title, hint);
        // A glance preview of the first detected words, below the date.
        if (r.preview) {
          const preview = document.createElement("span");
          preview.className = "recent-preview";
          preview.textContent = r.preview;
          btn.append(preview);
        }
        btn.addEventListener("click", () =>
          navigateToView({ name: "detail", itemId: r.id }),
        );
        return btn;
      });
      spacer.before(sec, ...recents);
    }
  }
  function refreshSidebar(): void {
    if (!deps.sidebarSummary) return;
    deps
      .sidebarSummary()
      .then((s) => {
        if (!shellDestroyed) applySummary(s);
      })
      .catch(() => {
        // Plain nav is the degradation — no error surface.
      });
  }
  refreshSidebar();

  // --- view container ---
  const container = document.createElement("main");
  container.className = "shell-view";

  const body = document.createElement("div");
  body.className = "shell-body";
  body.append(sidebar, container);

  root.append(toolbar, body);

  // --- REC pill (toolbar-resident, so it survives view changes) ---
  let recPill: HTMLButtonElement | null = null;
  let recLabel: Text | null = null;
  const onRecordingState = (s: { active: boolean; elapsedLabel: string }) => {
    if (!s.active) {
      recPill?.remove();
      recPill = null;
      recLabel = null;
      return;
    }
    if (!recPill) {
      recPill = document.createElement("button");
      recPill.className = "pill reclive";
      recPill.type = "button";
      recPill.setAttribute("aria-label", t("rec.pillAria"));
      const dot = document.createElement("span");
      dot.className = "dot";
      recLabel = document.createTextNode("");
      recPill.append(dot, recLabel);
      recPill.addEventListener("click", () => {
        navigateToView({ name: "home" });
      });
      toolbar.insertBefore(recPill, modelPill);
    }
    if (recLabel) recLabel.textContent = `REC ${s.elapsedLabel}`;
  };
  const offRecording = deps.recordingState?.(onRecordingState);

  let firstView = true;
  const off = onViewChange((view) => {
    for (const [name, el] of navItems) {
      el.classList.toggle("active", name === view.name);
    }
    renderView(view, container);
    // Re-pull the sidebar counts/recents on navigation so a delete (or a new
    // capture) reflects without a reload. Skip the initial fire — refreshSidebar
    // already ran once above.
    if (!firstView) refreshSidebar();
    firstView = false;
  });

  return {
    /** Re-pull the sidebar counts/recents — call after items change without a
     *  navigation (e.g. a capture lands or an item is deleted on the same view). */
    refresh() {
      refreshSidebar();
    },
    destroy() {
      shellDestroyed = true;
      off();
      offRecording?.();
      root.replaceChildren();
      root.classList.remove("app-shell");
    },
  };
}
