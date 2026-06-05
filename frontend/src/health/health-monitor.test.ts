import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthMonitor, type HealthState } from "./health-monitor";

function makeFetchStub(
  responses: (Response | Error)[],
): { fn: typeof fetch; calls: number } {
  let i = 0;
  const calls = { n: 0 };
  const fn = (async () => {
    calls.n++;
    const r = responses[i++ % responses.length];
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { fn, calls: 0 } as unknown as { fn: typeof fetch; calls: number };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("HealthMonitor", () => {
  let onState: ReturnType<typeof vi.fn<(s: HealthState) => void>>;

  beforeEach(() => {
    onState = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onStateChange to 'ok' after a successful initial check", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const m = new HealthMonitor({ url: "/status", onStateChange: onState, fetchImpl });
    m.start();
    await flushMicrotasks();
    expect(onState).toHaveBeenCalledWith("ok");
    expect(m.getState()).toBe("ok");
    m.stop();
  });

  it("reports 'down' when the fetch rejects", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const m = new HealthMonitor({ url: "/status", onStateChange: onState, fetchImpl });
    m.start();
    await flushMicrotasks();
    expect(onState).toHaveBeenCalledWith("down");
    m.stop();
  });

  it("reports 'down' when the response is a non-2xx status", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("oops", { status: 503 }));
    const m = new HealthMonitor({ url: "/status", onStateChange: onState, fetchImpl });
    m.start();
    await flushMicrotasks();
    expect(onState).toHaveBeenCalledWith("down");
    m.stop();
  });

  it("does not fire onStateChange when the state is unchanged across two checks", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const m = new HealthMonitor({
      url: "/status",
      onStateChange: onState,
      intervalMs: 1_000,
      fetchImpl,
    });
    m.start();
    await flushMicrotasks();
    expect(onState).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    await flushMicrotasks();
    expect(onState).toHaveBeenCalledTimes(1); // still ok → no change
    m.stop();
  });

  it("re-checks on the interval timer", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("nope", { status: 502 }));
    const m = new HealthMonitor({
      url: "/status",
      onStateChange: onState,
      intervalMs: 1_000,
      fetchImpl,
    });
    m.start();
    await flushMicrotasks();
    vi.advanceTimersByTime(1_000);
    await flushMicrotasks();
    expect(onState).toHaveBeenLastCalledWith("down");
    m.stop();
  });

  it("checkNow() returns the resolved state without waiting for the timer", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("err", { status: 500 }));
    const m = new HealthMonitor({
      url: "/status",
      onStateChange: onState,
      intervalMs: 60_000,
      fetchImpl,
    });
    m.start();
    await flushMicrotasks();
    expect(m.getState()).toBe("ok");
    const next = await m.checkNow();
    expect(next).toBe("down");
    m.stop();
  });

  it("re-checks when the tab visibility changes to 'visible'", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const m = new HealthMonitor({
      url: "/status",
      onStateChange: onState,
      intervalMs: 60_000,
      fetchImpl,
    });
    m.start();
    await flushMicrotasks();
    expect(m.getState()).toBe("down");

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushMicrotasks();
    expect(m.getState()).toBe("ok");
    m.stop();
  });

  it("stop() clears the interval and removes the visibility listener", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const m = new HealthMonitor({
      url: "/status",
      onStateChange: onState,
      intervalMs: 1_000,
      fetchImpl,
    });
    m.start();
    await flushMicrotasks();
    m.stop();
    onState.mockClear();
    vi.advanceTimersByTime(5_000);
    await flushMicrotasks();
    expect(onState).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only the initial check
  });
});

// Suppress unused warning for makeFetchStub which would be useful if we want
// shared response sequences across tests.
void makeFetchStub;
