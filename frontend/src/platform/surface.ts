/**
 * Surface profile (fe-surface-profile): the single source of truth for
 * per-surface presentation. The desktop (Tauri) app and the web PWA load one
 * bundle but serve two mental models — desktop = workspace (Library / Runs /
 * Models management); web = quick-capture tool. Rather than scattering
 * `isDesktopShell()` branches across the views, every layout/navigation
 * decision reads a `SurfaceProfile` resolved once here.
 *
 * `isDesktopShell()` (capability.ts) stays the low-level capability probe; it
 * is consulted here to pick the surface, and nowhere else for layout decisions.
 */

import { isDesktopShell } from "./capability";
import type { View } from "../routing/view-route";

export type Surface = "desktop" | "web";

/** A top-level destination name — the nav / landing axis of the router. */
export type ViewName = View["name"];

export interface SurfaceProfile {
  surface: Surface;
  /** View navigated to on boot when the location hash is empty. */
  defaultView: ViewName;
  /** Nav items the shell sidebar renders, in order. */
  nav: ViewName[];
  /** Home layout density: `full` shows the dashboard rows; `compact` omits
   *  them and foregrounds the capture entry. */
  homeDensity: "full" | "compact";
  /** Show the desktop-only Shortcuts settings (global hotkey, auto-paste). */
  showDesktopShortcuts: boolean;
  /** Show the desktop-only Experimental settings. */
  showExperimental: boolean;
  /** Whether Models management is reachable on this surface. */
  modelsAccess: "full" | "hidden";
}

const DESKTOP: SurfaceProfile = {
  surface: "desktop",
  defaultView: "library",
  nav: ["home", "library", "models", "settings"],
  homeDensity: "full",
  showDesktopShortcuts: true,
  showExperimental: true,
  modelsAccess: "full",
};

const WEB: SurfaceProfile = {
  surface: "web",
  defaultView: "home",
  nav: ["home", "library", "settings"],
  homeDensity: "compact",
  showDesktopShortcuts: false,
  showExperimental: false,
  modelsAccess: "hidden",
};

/** Resolve the runtime surface: desktop inside the Tauri shell, else web. */
export function resolveSurface(): Surface {
  return isDesktopShell() ? "desktop" : "web";
}

/**
 * The complete presentation profile for a surface. Only an explicit `"web"`
 * yields the trimmed profile; anything else falls through to the full desktop
 * profile so a wiring mistake fails safe toward more-visible — never hiding
 * desktop OS features behind a wrong default. A fresh `nav` copy is returned so
 * callers cannot mutate the shared constant.
 */
export function surfaceProfile(surface: Surface): SurfaceProfile {
  const base = surface === "web" ? WEB : DESKTOP;
  return { ...base, nav: [...base.nav] };
}

/**
 * Boot-landing decision: with the location hash at the app root, the surface
 * lands on its default view; a non-empty deep-link hash is honored (returns
 * `null` — don't override it). `parseViewHash` keeps its own empty/unknown →
 * home fallback as the router's safety net, so a `null` here means "let the
 * router resolve the current hash unchanged".
 */
export function bootLandingView(
  hash: string,
  defaultView: ViewName,
): View | null {
  const atRoot = hash === "" || hash === "#" || hash === "#/";
  if (!atRoot) return null;
  return defaultView === "library" ? { name: "library" } : { name: "home" };
}
