/**
 * Tests for the listen-socket WebSocket wrapper (Decision 3 of
 * v2-4-pwa-listen-client).
 *
 * The real WebSocket is replaced with a controllable mock so we can assert
 * the reconnect schedule, emitted events, and session-offset translation
 * without touching the network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ListenSocket, RECONNECT_DELAYS_MS } from "./listen-socket";

/** Flush a couple of microtask cycles so queued `queueMicrotask` callbacks run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  url: string;
  sent: ArrayBuffer[] = [];
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    if (MockWebSocket.failNextConnects > 0) {
      MockWebSocket.failNextConnects -= 1;
      // Fast-fail: close before onopen ever fires (simulates connect failure).
      queueMicrotask(() => {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.call(
          this as unknown as WebSocket,
          new CloseEvent("close", { wasClean: false, code: 1006 }),
        );
      });
    } else {
      // Normal: fire open asynchronously to mimic real WS handshake completion.
      queueMicrotask(() => this.onopen?.call(this as unknown as WebSocket, new Event("open")));
    }
  }

  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.call(
      this as unknown as WebSocket,
      new CloseEvent("close", { wasClean: true }),
    );
  }

  /** Test helper: receive a JSON event from the "server". */
  receive(payload: unknown): void {
    const ev = new MessageEvent("message", { data: JSON.stringify(payload) });
    this.onmessage?.call(this as unknown as WebSocket, ev);
  }

  /** Test helper: simulate an unexpected disconnect. */
  disconnect(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.call(
      this as unknown as WebSocket,
      new CloseEvent("close", { wasClean: false, code: 1006 }),
    );
  }

  static instances: MockWebSocket[] = [];
  static failNextConnects = 0;
  static reset(): void {
    MockWebSocket.instances = [];
    MockWebSocket.failNextConnects = 0;
  }
}

describe("ListenSocket", () => {
  beforeEach(() => {
    MockWebSocket.reset();
    vi.useFakeTimers();
    (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket =
      MockWebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports the documented exponential-backoff reconnect schedule", () => {
    expect(RECONNECT_DELAYS_MS).toEqual([
      1000, 2000, 4000, 8000, 16000, 16000, 16000, 16000, 16000, 16000,
    ]);
  });

  it("emits partial and final events with passed-through fields on the initial connection", async () => {
    const events: unknown[] = [];
    const sock = new ListenSocket({
      url: "ws://localhost:8000/listen",
      onEvent: (e) => events.push(e),
    });
    sock.start();
    await flushMicrotasks();

    const ws = MockWebSocket.instances[0]!;
    ws.receive({ type: "partial", text: "hello", start_ms: 0, end_ms: 250 });
    ws.receive({ type: "final", text: "hello world", start_ms: 0, end_ms: 1500 });

    expect(events).toContainEqual({
      type: "state",
      state: "open",
    });
    expect(events).toContainEqual({
      type: "partial",
      text: "hello",
      start_ms: 0,
      end_ms: 250,
    });
    expect(events).toContainEqual({
      type: "final",
      text: "hello world",
      start_ms: 0,
      end_ms: 1500,
    });
  });

  it("reconnects with the documented backoff and preserves finals across disconnect", async () => {
    const events: { type: string; [k: string]: unknown }[] = [];
    const sock = new ListenSocket({
      url: "ws://localhost:8000/listen",
      onEvent: (e) => events.push(e),
    });
    sock.start();
    await flushMicrotasks();

    // Initial connection: one final at 0..1500.
    let ws = MockWebSocket.instances[0]!;
    ws.receive({ type: "final", text: "first", start_ms: 0, end_ms: 1500 });

    // Simulate an unexpected drop.
    ws.disconnect();

    // We should see a "reconnecting" state and the next attempt at +1000 ms.
    expect(events.some((e) => e.type === "state" && e.state === "reconnecting")).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(MockWebSocket.instances.length).toBe(2);
    ws = MockWebSocket.instances[1]!;

    // Server emits a new final, time-relative to the new connection.
    ws.receive({ type: "final", text: "second", start_ms: 0, end_ms: 1000 });

    // The two finals on the consumer side must be monotonic — second's
    // translated start_ms SHALL exceed first's end_ms.
    const finals = events.filter((e) => e.type === "final") as unknown as Array<{
      text: string;
      start_ms: number;
      end_ms: number;
    }>;
    expect(finals).toHaveLength(2);
    expect(finals[0].text).toBe("first");
    expect(finals[1].text).toBe("second");
    expect(finals[1].start_ms).toBeGreaterThanOrEqual(finals[0].end_ms);
  });

  it("gives up after 10 consecutive failed connect attempts and reports state='failed'", async () => {
    // Make every WS constructed in this test fast-fail (close before onopen).
    // 1 initial + 10 reconnect attempts = 11 connects total.
    MockWebSocket.failNextConnects = 11;
    const events: { type: string; [k: string]: unknown }[] = [];
    const sock = new ListenSocket({
      url: "ws://localhost:8000/listen",
      onEvent: (e) => events.push(e),
    });
    sock.start();

    // Drain the initial connect's onclose microtask and every subsequent
    // reconnect timer + its onclose microtask.
    await flushMicrotasks();
    for (const delayMs of RECONNECT_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delayMs);
      await flushMicrotasks();
    }

    // After 10 failed attempts the wrapper SHALL stop trying and report failure.
    expect(events.some((e) => e.type === "state" && e.state === "failed")).toBe(true);
    expect(MockWebSocket.instances.length).toBe(11);
  });

  it("user-initiated stop() does NOT trigger reconnect", async () => {
    const events: { type: string; [k: string]: unknown }[] = [];
    const sock = new ListenSocket({
      url: "ws://localhost:8000/listen",
      onEvent: (e) => events.push(e),
    });
    sock.start();
    await flushMicrotasks();
    sock.stop();
    await vi.advanceTimersByTimeAsync(20000);

    // Only the initial connection should have been opened.
    expect(MockWebSocket.instances.length).toBe(1);
    expect(events.some((e) => e.type === "state" && e.state === "reconnecting")).toBe(
      false,
    );
  });
});
