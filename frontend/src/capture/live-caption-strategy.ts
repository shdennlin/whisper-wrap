/**
 * Live caption strategy (fe-recording-modes).
 *
 * "Live" is not one fixed mechanism: a batch ASR can only emulate it via the
 * server-side windowed-batch /listen stream, while a streaming-capable ASR
 * (cloud endpoint or streaming model) could feed captions natively. The active
 * ASR's capability decides which strategy applies; the UI reads the single
 * resolved value to decide live availability and which hint to show.
 *
 * Today only `windowed-batch` is wired (the existing ListenSocket over WS
 * /listen). `native-stream` is the seam follow-up providers plug into — without
 * it each provider would have to re-touch the capture UI.
 */

import {
  ListenSocket,
  type ConnectionState,
  type ListenEvent,
} from "./listen-socket";

export type LiveStrategy = "native-stream" | "windowed-batch" | "none";

/** What the active ASR can do for live captions. */
export interface AsrCapability {
  /** Runs locally via Whisper → supports the WS /listen windowed-batch
   *  emulation. */
  localWhisper: boolean;
  /** Exposes a native low-latency streaming path (cloud streaming /
   *  streaming-capable model). Not wired yet — reserved for follow-ups. */
  nativeStream?: boolean;
}

/** Caption callbacks receive the text plus the (offset-translated) timing. */
export type CaptionHandler = (
  text: string,
  startMs: number,
  endMs: number,
) => void;

/**
 * The consumer attached to the capture session's PCM frame stream. One
 * interface so a future native-stream provider is a drop-in replacement for
 * the windowed-batch sink.
 */
export interface LiveCaptionSink {
  open(): Promise<void>;
  pushFrame(frame: ArrayBuffer): void;
  close(): Promise<void>;
  onPartial(cb: CaptionHandler): void;
  onFinal(cb: CaptionHandler): void;
  readonly state: ConnectionState;
}

export interface CreateLiveSinkOptions {
  /** WS URL for the /listen endpoint (windowed-batch). */
  wsUrl: string;
}

/** Resolve the live strategy from the active ASR capability. */
export function resolveLiveStrategy(asr: AsrCapability): LiveStrategy {
  if (asr.nativeStream) return "native-stream";
  if (asr.localWhisper) return "windowed-batch";
  return "none";
}

/**
 * Build the sink for a strategy: the listen-socket-backed sink for
 * `windowed-batch`, and `null` for `none` (and for the not-yet-wired
 * `native-stream`) so the caller knows there is nothing to attach.
 */
export function createLiveSink(
  strategy: LiveStrategy,
  opts: CreateLiveSinkOptions,
): LiveCaptionSink | null {
  if (strategy === "windowed-batch") return new WindowedBatchSink(opts.wsUrl);
  return null;
}

/** Windowed-batch sink: wraps ListenSocket (WS /listen) so its reconnect +
 *  timestamp-offset logic is reused rather than reimplemented. */
class WindowedBatchSink implements LiveCaptionSink {
  private socket: ListenSocket | null = null;
  private partialCb: CaptionHandler | null = null;
  private finalCb: CaptionHandler | null = null;
  private connState: ConnectionState = "idle";

  constructor(private readonly wsUrl: string) {}

  get state(): ConnectionState {
    return this.connState;
  }

  open(): Promise<void> {
    if (this.socket) return Promise.resolve();
    this.socket = new ListenSocket({
      url: this.wsUrl,
      onEvent: (e) => this.handle(e),
    });
    this.socket.start();
    return Promise.resolve();
  }

  pushFrame(frame: ArrayBuffer): void {
    this.socket?.send(frame);
  }

  close(): Promise<void> {
    this.socket?.stop();
    this.socket = null;
    this.connState = "idle";
    return Promise.resolve();
  }

  onPartial(cb: CaptionHandler): void {
    this.partialCb = cb;
  }

  onFinal(cb: CaptionHandler): void {
    this.finalCb = cb;
  }

  private handle(e: ListenEvent): void {
    if (e.type === "state") this.connState = e.state;
    else if (e.type === "partial") this.partialCb?.(e.text, e.start_ms, e.end_ms);
    else if (e.type === "final") this.finalCb?.(e.text, e.start_ms, e.end_ms);
  }
}
