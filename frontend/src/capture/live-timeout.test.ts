import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTimeoutManager } from "./live-timeout";

describe("LiveTimeoutManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires 'idle' after the idle threshold with no activity", () => {
    const onTimeout = vi.fn();
    const m = new LiveTimeoutManager({
      idleMinutes: 1,
      maxMinutes: 0,
      onTimeout,
    });
    m.start();
    vi.advanceTimersByTime(60_000);
    expect(onTimeout).toHaveBeenCalledWith("idle");
  });

  it("resets the idle timer when onActivity() is called", () => {
    const onTimeout = vi.fn();
    const m = new LiveTimeoutManager({
      idleMinutes: 1,
      maxMinutes: 0,
      onTimeout,
    });
    m.start();
    vi.advanceTimersByTime(45_000);
    m.onActivity();
    vi.advanceTimersByTime(45_000);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15_000);
    expect(onTimeout).toHaveBeenCalledWith("idle");
  });

  it("fires 'max' when the hard cap elapses regardless of activity", () => {
    const onTimeout = vi.fn();
    const m = new LiveTimeoutManager({
      idleMinutes: 60, // long enough that idle never fires first
      maxMinutes: 1,
      onTimeout,
    });
    m.start();
    // Pretend the user keeps talking — onActivity every 30 s.
    for (let t = 0; t < 60_000; t += 30_000) {
      vi.advanceTimersByTime(30_000);
      m.onActivity();
    }
    expect(onTimeout).toHaveBeenCalledWith("max");
  });

  it("0 disables the idle timer", () => {
    const onTimeout = vi.fn();
    const m = new LiveTimeoutManager({
      idleMinutes: 0,
      maxMinutes: 0,
      onTimeout,
    });
    m.start();
    vi.advanceTimersByTime(60 * 60_000); // an hour of nothing
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("0 disables the max timer", () => {
    const onTimeout = vi.fn();
    const m = new LiveTimeoutManager({
      idleMinutes: 0,
      maxMinutes: 0,
      onTimeout,
    });
    m.start();
    vi.advanceTimersByTime(10 * 60 * 60_000); // ten hours
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("stop() cancels both timers", () => {
    const onTimeout = vi.fn();
    const m = new LiveTimeoutManager({
      idleMinutes: 1,
      maxMinutes: 5,
      onTimeout,
    });
    m.start();
    m.stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("only fires once even if both timers would have fired", () => {
    const onTimeout = vi.fn();
    const m = new LiveTimeoutManager({
      idleMinutes: 1,
      maxMinutes: 1,
      onTimeout,
    });
    m.start();
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(60_000);
    // idle should fire first and stop the manager so 'max' never fires
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith("idle");
  });
});
