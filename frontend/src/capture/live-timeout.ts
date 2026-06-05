/**
 * Two-tier auto-stop for Live recordings.
 *
 *   idle: counts wall-clock since the last "activity" event (final received
 *         OR user pause/resume); fires `onTimeout("idle")` when the threshold
 *         elapses without any activity. Reset every time onActivity() runs.
 *
 *   max:  hard ceiling on wall-clock since start(); fires `onTimeout("max")`
 *         regardless of pause state. Acts as the last line of defence for
 *         genuinely abandoned recordings.
 *
 * Either tier can be disabled by passing 0 (or a non-positive number).
 * Both timers are torn down by stop(); the caller owns the actual recording
 * lifecycle — this class only emits the timeout signal.
 */

export type LiveTimeoutReason = "idle" | "max";

export interface LiveTimeoutOptions {
  /** Stop after this many minutes with no activity. 0 disables idle stop. */
  idleMinutes: number;
  /** Hard cap on total recording wall-clock. 0 disables the cap. */
  maxMinutes: number;
  onTimeout: (reason: LiveTimeoutReason) => void;
  /** Override setTimeout/clearTimeout (used by tests). */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (h: ReturnType<typeof setTimeout>) => void;
  };
}

const MIN_TO_MS = 60_000;

export class LiveTimeoutManager {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly opts: LiveTimeoutOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleIdle();
    if (this.opts.maxMinutes > 0) {
      this.maxTimer = this.timers().setTimeout(
        () => this.fire("max"),
        this.opts.maxMinutes * MIN_TO_MS,
      );
    }
  }

  /** Call when a final arrives, or when the user pauses/resumes. */
  onActivity(): void {
    if (!this.running) return;
    this.scheduleIdle();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.idleTimer !== null) {
      this.timers().clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.maxTimer !== null) {
      this.timers().clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
  }

  private scheduleIdle(): void {
    if (this.idleTimer !== null) {
      this.timers().clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.opts.idleMinutes <= 0) return;
    this.idleTimer = this.timers().setTimeout(
      () => this.fire("idle"),
      this.opts.idleMinutes * MIN_TO_MS,
    );
  }

  private fire(reason: LiveTimeoutReason): void {
    this.stop();
    this.opts.onTimeout(reason);
  }

  private timers() {
    return (
      this.opts.scheduler ?? {
        setTimeout: (fn: () => void, ms: number) =>
          setTimeout(fn, ms) as ReturnType<typeof setTimeout>,
        clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
      }
    );
  }
}
