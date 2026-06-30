import { afterEach, describe, expect, it, vi } from "vitest";

import { subscribeSessionEvents } from "./session-events";

/** Minimal EventSource stub: records instances and lets tests fire events. */
class StubEventSource {
  static instances: StubEventSource[] = [];
  url: string;
  closed = false;
  private listeners: Record<string, ((e: MessageEvent) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    StubEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (e: MessageEvent) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    for (const cb of this.listeners[type] ?? []) {
      cb({ data } as MessageEvent);
    }
  }
}

afterEach(() => {
  StubEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe("subscribeSessionEvents", () => {
  it("invokes onChange on each `changed` event", () => {
    const onChange = vi.fn();
    subscribeSessionEvents({
      onChange,
      EventSourceCtor: StubEventSource as unknown as typeof EventSource,
    });
    const es = StubEventSource.instances[0];

    es.emit("changed", JSON.stringify({ reason: "created" }));
    es.emit("changed", JSON.stringify({ reason: "finalized" }));

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("runs one catch-up onChange after a reconnect (second open), not the first", () => {
    const onChange = vi.fn();
    subscribeSessionEvents({
      onChange,
      EventSourceCtor: StubEventSource as unknown as typeof EventSource,
    });
    const es = StubEventSource.instances[0];

    es.emit("open"); // initial connect — data already loaded, no catch-up
    expect(onChange).toHaveBeenCalledTimes(0);

    es.emit("open"); // reconnect — catch up on anything missed while down
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("returns a no-op and does not throw when EventSource is unavailable", () => {
    vi.stubGlobal("EventSource", undefined);
    const onChange = vi.fn();

    let stop: (() => void) | undefined;
    expect(() => {
      stop = subscribeSessionEvents({ onChange });
    }).not.toThrow();
    expect(StubEventSource.instances).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(() => stop?.()).not.toThrow();
  });

  it("closes the stream when the returned unsubscribe is called", () => {
    const onChange = vi.fn();
    const stop = subscribeSessionEvents({
      onChange,
      EventSourceCtor: StubEventSource as unknown as typeof EventSource,
    });
    const es = StubEventSource.instances[0];

    stop();
    expect(es.closed).toBe(true);
  });
});
