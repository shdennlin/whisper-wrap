/**
 * HealthMonitor tests.
 *
 * The monitor no longer takes a `fetchImpl`; its `GET /status` probe routes
 * through the shared generated client. Tests stub the client's ONE `fetch`
 * (`setClientFetch`) instead of injecting a per-instance fetch. `/status`
 * returns JSON, so stub responses carry a JSON body (the probe reads only
 * `response.ok`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClientFetch, setClientFetch } from "../api/client";
import { HealthMonitor, type HealthState } from "./health-monitor";

/** A JSON Response for the client's injectable `fetch` seam. */
function jsonResp(status: number, body: unknown = { status: "ok" }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function flushMicrotasks(): Promise<void> {
  // A few extra ticks over the pre-migration count: routing through
  // openapi-fetch adds internal `await`s (request build + body parse).
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("HealthMonitor", () => {
  let onState: ReturnType<typeof vi.fn<(s: HealthState) => void>>;

  beforeEach(() => {
    onState = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetClientFetch();
    vi.useRealTimers();
  });

  it("fires onStateChange to 'ok' after a successful initial check", async () => {
    const fetchMock = vi.fn(async () => jsonResp(200));
    setClientFetch(fetchMock as unknown as typeof fetch);
    const m = new HealthMonitor({ onStateChange: onState });
    m.start();
    await flushMicrotasks();
    expect(onState).toHaveBeenCalledWith("ok");
    expect(m.getState()).toBe("ok");
    m.stop();
  });

  it("reports 'down' when the fetch rejects", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    setClientFetch(fetchMock as unknown as typeof fetch);
    const m = new HealthMonitor({ onStateChange: onState });
    m.start();
    await flushMicrotasks();
    expect(onState).toHaveBeenCalledWith("down");
    m.stop();
  });

  it("reports 'down' when the response is a non-2xx status", async () => {
    const fetchMock = vi.fn(async () => jsonResp(503, { detail: "oops" }));
    setClientFetch(fetchMock as unknown as typeof fetch);
    const m = new HealthMonitor({ onStateChange: onState });
    m.start();
    await flushMicrotasks();
    expect(onState).toHaveBeenCalledWith("down");
    m.stop();
  });

  it("does not fire onStateChange when the state is unchanged across two checks", async () => {
    const fetchMock = vi.fn(async () => jsonResp(200));
    setClientFetch(fetchMock as unknown as typeof fetch);
    const m = new HealthMonitor({
      onStateChange: onState,
      intervalMs: 1_000,
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResp(200))
      .mockResolvedValueOnce(jsonResp(502, { detail: "nope" }));
    setClientFetch(fetchMock as unknown as typeof fetch);
    const m = new HealthMonitor({
      onStateChange: onState,
      intervalMs: 1_000,
    });
    m.start();
    await flushMicrotasks();
    vi.advanceTimersByTime(1_000);
    await flushMicrotasks();
    expect(onState).toHaveBeenLastCalledWith("down");
    m.stop();
  });

  it("checkNow() returns the resolved state without waiting for the timer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResp(200))
      .mockResolvedValueOnce(jsonResp(500, { detail: "err" }));
    setClientFetch(fetchMock as unknown as typeof fetch);
    const m = new HealthMonitor({
      onStateChange: onState,
      intervalMs: 60_000,
    });
    m.start();
    await flushMicrotasks();
    expect(m.getState()).toBe("ok");
    const next = await m.checkNow();
    expect(next).toBe("down");
    m.stop();
  });

  it("re-checks when the tab visibility changes to 'visible'", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResp(500, { detail: "err" }))
      .mockResolvedValueOnce(jsonResp(200));
    setClientFetch(fetchMock as unknown as typeof fetch);
    const m = new HealthMonitor({
      onStateChange: onState,
      intervalMs: 60_000,
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
    const fetchMock = vi.fn(async () => jsonResp(200));
    setClientFetch(fetchMock as unknown as typeof fetch);
    const m = new HealthMonitor({
      onStateChange: onState,
      intervalMs: 1_000,
    });
    m.start();
    await flushMicrotasks();
    m.stop();
    onState.mockClear();
    vi.advanceTimersByTime(5_000);
    await flushMicrotasks();
    expect(onState).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial check
  });
});
