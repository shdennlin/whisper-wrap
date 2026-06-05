/**
 * Background backend-health probe.
 *
 * Fires `GET /status` on:
 *   - explicit start() (initial check on page load)
 *   - a fixed-interval timer (default 30 s) while running
 *   - `document.visibilitychange` when the tab returns to "visible"
 *   - explicit checkNow() (used right before the user presses record)
 *
 * The probe is idempotent: a new check aborts any in-flight one so we never
 * stack requests. `onStateChange` only fires when the resolved state changes,
 * so consumers can disable/enable the record buttons without flicker.
 */

export type HealthState = "checking" | "ok" | "down";

export const DEFAULT_HEALTH_INTERVAL_MS = 30_000;

export interface HealthMonitorOptions {
  url: string;
  intervalMs?: number;
  onStateChange: (state: HealthState) => void;
  /** Override fetch (used by tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export class HealthMonitor {
  private state: HealthState = "checking";
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private inFlight: AbortController | null = null;

  constructor(private readonly opts: HealthMonitorOptions) {}

  /** Begin polling. Idempotent — calling start() twice does nothing extra. */
  start(): void {
    if (this.intervalId !== null) return;
    void this.check();
    this.intervalId = setInterval(
      () => void this.check(),
      this.opts.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
    );
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibility);
    }
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibility);
    }
    this.inFlight?.abort();
    this.inFlight = null;
  }

  /** Force an immediate check; resolves to the post-check state. */
  async checkNow(): Promise<HealthState> {
    await this.check();
    return this.state;
  }

  getState(): HealthState {
    return this.state;
  }

  private handleVisibility = (): void => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "visible"
    ) {
      void this.check();
    }
  };

  private async check(): Promise<void> {
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const fetchFn = this.opts.fetchImpl ?? fetch;
    try {
      const res = await fetchFn(this.opts.url, { signal: controller.signal });
      if (controller.signal.aborted) return;
      this.setState(res.ok ? "ok" : "down");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      this.setState("down");
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  private setState(next: HealthState): void {
    if (next === this.state) return;
    this.state = next;
    this.opts.onStateChange(next);
  }
}
