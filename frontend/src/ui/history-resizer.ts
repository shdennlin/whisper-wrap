/**
 * Vertical drag-resizer between the recording main pane and the embedded
 * HistoryView (desktop one-page mode, ≥1200px viewport). The handle drives
 * a CSS custom property `--history-width` on `.recording-shell`, which the
 * grid template column references. Width is persisted to localStorage so
 * users don't have to re-tune it on every page load.
 *
 * Only active on desktop viewports — on narrow screens the recordingShell
 * layout collapses to single-column and the resizer is hidden via CSS.
 */

const STORAGE_KEY = "whisper-wrap.historyWidth";
const DEFAULT_WIDTH = 520;
const MIN_WIDTH = 320;
/** Cap at 60 % of viewport so the main pane keeps at least 40 %. */
const MAX_WIDTH_FRAC = 0.6;

export interface HistoryResizerOptions {
  /** Element that owns the `--history-width` CSS variable + grid template. */
  shell: HTMLElement;
}

function clampWidth(px: number): number {
  const max = Math.floor(window.innerWidth * MAX_WIDTH_FRAC);
  return Math.max(MIN_WIDTH, Math.min(max, Math.round(px)));
}

function loadStoredWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_WIDTH;
    return clampWidth(n);
  } catch {
    // localStorage may throw in private-mode iOS Safari; fall back silently.
    return DEFAULT_WIDTH;
  }
}

function persistWidth(px: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(px));
  } catch {
    // ignored — width is restorable from default on next load.
  }
}

export class HistoryResizer {
  private readonly handle: HTMLElement;
  private readonly shell: HTMLElement;
  private dragStartX = 0;
  private dragStartWidth = 0;
  private isDragging = false;

  // Bound listeners for clean teardown.
  private readonly onPointerDown: (ev: PointerEvent) => void;
  private readonly onPointerMove: (ev: PointerEvent) => void;
  private readonly onPointerUp: (ev: PointerEvent) => void;

  constructor(opts: HistoryResizerOptions) {
    this.shell = opts.shell;

    const initial = loadStoredWidth();
    this.shell.style.setProperty("--history-width", `${initial}px`);

    this.handle = document.createElement("div");
    this.handle.className = "history-resizer";
    this.handle.dataset.testid = "history-resizer";
    this.handle.setAttribute("role", "separator");
    this.handle.setAttribute("aria-orientation", "vertical");
    this.handle.tabIndex = 0;

    this.onPointerDown = (ev) => this.handlePointerDown(ev);
    this.onPointerMove = (ev) => this.handlePointerMove(ev);
    this.onPointerUp = (ev) => this.handlePointerUp(ev);

    this.handle.addEventListener("pointerdown", this.onPointerDown);
    this.handle.addEventListener("pointermove", this.onPointerMove);
    this.handle.addEventListener("pointerup", this.onPointerUp);
    this.handle.addEventListener("pointercancel", this.onPointerUp);
  }

  element(): HTMLElement {
    return this.handle;
  }

  destroy(): void {
    this.handle.removeEventListener("pointerdown", this.onPointerDown);
    this.handle.removeEventListener("pointermove", this.onPointerMove);
    this.handle.removeEventListener("pointerup", this.onPointerUp);
    this.handle.removeEventListener("pointercancel", this.onPointerUp);
    this.handle.remove();
  }

  private currentWidth(): number {
    const raw = getComputedStyle(this.shell).getPropertyValue("--history-width");
    const px = Number.parseInt(raw, 10);
    return Number.isFinite(px) && px > 0 ? px : DEFAULT_WIDTH;
  }

  private handlePointerDown(ev: PointerEvent): void {
    this.isDragging = true;
    this.dragStartX = ev.clientX;
    this.dragStartWidth = this.currentWidth();
    try {
      this.handle.setPointerCapture?.(ev.pointerId);
    } catch {
      // ignored — capture is an enhancement, not a requirement.
    }
    document.body.classList.add("is-resizing-history");
  }

  private handlePointerMove(ev: PointerEvent): void {
    if (!this.isDragging) return;
    // Handle sits between main (left) and history (right). Dragging LEFT
    // grows history, dragging RIGHT shrinks it — hence `startX - clientX`.
    const delta = this.dragStartX - ev.clientX;
    const next = clampWidth(this.dragStartWidth + delta);
    this.shell.style.setProperty("--history-width", `${next}px`);
  }

  private handlePointerUp(ev: PointerEvent): void {
    if (!this.isDragging) return;
    this.isDragging = false;
    try {
      this.handle.releasePointerCapture?.(ev.pointerId);
    } catch {
      // ignored
    }
    document.body.classList.remove("is-resizing-history");
    persistWidth(this.currentWidth());
  }
}
