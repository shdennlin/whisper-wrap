/**
 * Live caption strategy (fe-recording-modes).
 *
 * "Live" is not one fixed mechanism: a batch ASR can only emulate it via the
 * server-side windowed-batch /listen stream, while a streaming-capable ASR
 * (cloud endpoint or streaming model) could feed captions natively. The active
 * ASR's capability decides which strategy applies; the UI reads the single
 * resolved value to decide live availability and which hint to show.
 *
 * Both wired strategies ride the same WS /listen sink: the SERVER dispatches
 * native vs windowed-batch per active model (asr-backend-nemotron), so
 * client-side the strategy value informs UI affordances (availability, hint
 * copy), not the transport.
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
  /** Exposes a native low-latency streaming path (a streaming-capable model,
   *  e.g. parakeet-nemotron). Derived from the active model row's
   *  `supports_native_stream` — see {@link capabilityFromModels}. */
  nativeStream?: boolean;
}

/** The subset of a GET /models row the live-caption seam reads (structurally
 *  compatible with the generated `ModelEntry`). */
export interface LiveModelRow {
  name: string;
  supports_native_stream?: boolean;
}

/**
 * Derive the active ASR capability from the GET /models listing: the engine
 * is local (windowed-batch always available as the fallback), and native
 * streaming comes from the ACTIVE model row's `supports_native_stream` flag.
 */
export function capabilityFromModels(listing: {
  active: string;
  models: LiveModelRow[];
}): AsrCapability {
  const row = listing.models.find((m) => m.name === listing.active);
  return {
    localWhisper: true,
    nativeStream: row?.supports_native_stream === true,
  };
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
 * Build the sink for a strategy, or `null` for `none` so the caller knows
 * there is nothing to attach. `native-stream` and `windowed-batch` share the
 * listen-socket sink: the server decides the decode path per active model on
 * the same WS /listen, so the client-side transport is identical.
 */
export function createLiveSink(
  strategy: LiveStrategy,
  opts: CreateLiveSinkOptions,
): LiveCaptionSink | null {
  if (strategy === "windowed-batch" || strategy === "native-stream") {
    return new WindowedBatchSink(opts.wsUrl);
  }
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
