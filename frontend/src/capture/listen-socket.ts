/**
 * WebSocket wrapper for `WS /listen` with bounded auto-reconnect (Decision 3).
 *
 * Responsibilities:
 *   - Open the WS, emit `state` events as the connection transitions
 *   - Parse JSON `partial` / `final` events from the server and forward them
 *   - Auto-reconnect with the documented exponential-backoff sequence
 *     on unexpected disconnect
 *   - Preserve already-emitted finals across reconnect by translating
 *     `start_ms` / `end_ms` of post-reconnect events by a session-global
 *     offset, so the consumer sees monotonically increasing timestamps
 *   - Stop reconnecting after 10 failed attempts and report `state: "failed"`
 *
 * The 10-step delay sequence is taken from openspec/specs/pwa-listen-client/
 * spec.md: 1, 2, 4, 8, 16, 16, 16, 16, 16, 16 seconds.
 */

export const RECONNECT_DELAYS_MS: ReadonlyArray<number> = [
  1000, 2000, 4000, 8000, 16000, 16000, 16000, 16000, 16000, 16000,
];

export type ConnectionState = "idle" | "open" | "reconnecting" | "failed";

export type ListenEvent =
  | {
      type: "partial";
      text: string;
      start_ms: number;
      end_ms: number;
    }
  | {
      type: "final";
      text: string;
      start_ms: number;
      end_ms: number;
    }
  | { type: "state"; state: ConnectionState }
  | { type: "error"; message: string };

export interface ListenSocketOptions {
  url: string;
  onEvent: (event: ListenEvent) => void;
}

export class ListenSocket {
  private ws: WebSocket | null = null;
  private state: ConnectionState = "idle";
  private sessionOffsetMs = 0;
  private lastFinalEndMs = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Local-time anchor (`Date.now()`) of the most recent successful open. */
  private connectedAt = 0;

  constructor(private readonly options: ListenSocketOptions) {}

  start(): void {
    if (this.ws) return;
    this.stopped = false;
    this.openSocket();
  }

  /** Send a binary frame (raw 16 kHz `pcm_s16le` 4000-sample chunk). */
  send(frame: ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    }
  }

  /** User-initiated graceful close. SHALL NOT trigger reconnect. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setState("idle");
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.options.onEvent({ type: "state", state });
    }
  }

  private openSocket(): void {
    this.ws = new WebSocket(this.options.url);
    this.ws.onopen = () => {
      this.connectedAt = Date.now();
      this.reconnectAttempt = 0;
      // After a reconnect, the server starts emitting timestamps from 0 on the
      // new connection. The consumer expects globally monotonic times, so we
      // pin the offset at the last emitted final's end so post-reconnect events
      // appear "after" the prior session.
      this.sessionOffsetMs = this.lastFinalEndMs;
      this.setState("open");
    };
    this.ws.onmessage = (e: MessageEvent) => this.handleMessage(e);
    this.ws.onclose = (e: CloseEvent) => this.handleClose(e);
    this.ws.onerror = () => {
      // Closing yields onclose, where the reconnect decision happens.
    };
  }

  private handleMessage(e: MessageEvent): void {
    if (typeof e.data !== "string") {
      // Binary server-to-client messages are not part of the /listen protocol.
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.data);
    } catch {
      this.options.onEvent({
        type: "error",
        message: "received non-JSON frame from /listen",
      });
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;
    const type = obj.type;

    if (type === "partial" || type === "final") {
      const start_ms = numberField(obj.start_ms);
      const end_ms = numberField(obj.end_ms);
      const text = typeof obj.text === "string" ? obj.text : "";
      const translatedStart = start_ms + this.sessionOffsetMs;
      const translatedEnd = end_ms + this.sessionOffsetMs;
      if (type === "final") {
        this.lastFinalEndMs = Math.max(this.lastFinalEndMs, translatedEnd);
      }
      this.options.onEvent({
        type,
        text,
        start_ms: translatedStart,
        end_ms: translatedEnd,
      });
    } else if (type === "error") {
      this.options.onEvent({
        type: "error",
        message: typeof obj.message === "string" ? obj.message : "server error",
      });
    }
  }

  private handleClose(e: CloseEvent): void {
    this.ws = null;
    if (this.stopped) return;
    if (e.wasClean && this.state === "idle") return; // graceful close

    if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      this.setState("failed");
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt]!;
    this.reconnectAttempt += 1;
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.openSocket();
    }, delay);
  }

  /** Test-only accessor; not part of the public contract. */
  _testState(): ConnectionState {
    return this.state;
  }

  /** Hides 0-prefix dead-code warning from connectedAt usage. */
  _connectedAt(): number {
    return this.connectedAt;
  }
}

function numberField(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return 0;
}
