import { afterEach, describe, expect, it } from "vitest";

import {
  createLiveSink,
  resolveLiveStrategy,
} from "./live-caption-strategy";

describe("resolveLiveStrategy", () => {
  it("resolves local Whisper to windowed-batch", () => {
    expect(resolveLiveStrategy({ localWhisper: true })).toBe("windowed-batch");
  });

  it("resolves an ASR with no live path to none", () => {
    expect(resolveLiveStrategy({ localWhisper: false })).toBe("none");
  });

  it("prefers native-stream when the ASR exposes it (future seam)", () => {
    expect(
      resolveLiveStrategy({ localWhisper: true, nativeStream: true }),
    ).toBe("native-stream");
  });
});

describe("createLiveSink", () => {
  const realWS = globalThis.WebSocket;
  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWS;
  });

  it("returns null for none and for the unwired native-stream", () => {
    expect(createLiveSink("none", { wsUrl: "ws://x/listen" })).toBeNull();
    expect(createLiveSink("native-stream", { wsUrl: "ws://x/listen" })).toBeNull();
  });

  it("returns a listen-socket-backed sink for windowed-batch", () => {
    const urls: string[] = [];
    class FakeWS {
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 0;
      constructor(url: string) {
        urls.push(url);
      }
      send(): void {}
      close(): void {}
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;

    const sink = createLiveSink("windowed-batch", { wsUrl: "ws://x/listen" });
    expect(sink).not.toBeNull();
    expect(typeof sink!.open).toBe("function");
    expect(typeof sink!.pushFrame).toBe("function");
    expect(typeof sink!.close).toBe("function");

    // open() spins up the underlying ListenSocket against the given URL.
    void sink!.open();
    expect(urls).toEqual(["ws://x/listen"]);
    // Forwarding a frame and closing must not throw.
    expect(() => sink!.pushFrame(new ArrayBuffer(8))).not.toThrow();
    void sink!.close();
  });

  it("routes partial/final socket events to the registered callbacks", () => {
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      onopen: (() => void) | null = null;
      onclose: ((e: unknown) => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1;
      constructor() {
        sockets.push(this);
      }
      send(): void {}
      close(): void {}
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

    const sink = createLiveSink("windowed-batch", { wsUrl: "ws://x/listen" })!;
    const partials: string[] = [];
    const finals: string[] = [];
    sink.onPartial((text) => partials.push(text));
    sink.onFinal((text) => finals.push(text));
    void sink.open();

    const ws = sockets[0]!;
    ws.onmessage?.({
      data: JSON.stringify({ type: "partial", text: "你好", start_ms: 0, end_ms: 1 }),
    });
    ws.onmessage?.({
      data: JSON.stringify({ type: "final", text: "你好世界", start_ms: 0, end_ms: 2 }),
    });
    expect(partials).toEqual(["你好"]);
    expect(finals).toEqual(["你好世界"]);
  });
});
