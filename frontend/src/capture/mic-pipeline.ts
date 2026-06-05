/**
 * Host-side helper that wires the browser microphone to the AudioWorklet
 * downsampler and delivers 4000-sample (250 ms) Int16 frames via callback.
 */

import workletUrl from "./audio-worklet.js?url";

export type FrameHandler = (frame: ArrayBuffer) => void;

export interface MicPipelineOptions {
  /** `deviceId` for `navigator.mediaDevices.getUserMedia({audio: {deviceId}})`. */
  deviceId?: string;
  onFrame: FrameHandler;
}

export class MicPipeline {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  /** When true, downsampled frames are dropped instead of being forwarded. */
  private paused = false;

  constructor(private readonly options: MicPipelineOptions) {}

  async start(): Promise<void> {
    if (this.ctx) {
      throw new Error("MicPipeline already started");
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.options.deviceId
          ? { exact: this.options.deviceId }
          : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000, // Hint only — browser may ignore.
      },
      video: false,
    });

    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(workletUrl);

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    this.node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (this.paused) return;
      this.options.onFrame(e.data);
    };
    this.source.connect(this.node);
  }

  /**
   * Drop frames at the host edge (the worklet keeps running but its output is
   * not forwarded to onFrame). The server-side /listen stream will see no new
   * audio and will eventually emit any pending utterance as a final.
   */
  pause(): void {
    this.paused = true;
  }

  /** Resume forwarding worklet output to onFrame. */
  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Returns the underlying MediaStream once `start()` has resolved, or null
   * before. Exposed so a parallel `DualRecorder` can attach a MediaRecorder
   * to the same source for compressed audio persistence without re-acquiring
   * the microphone.
   */
  getStream(): MediaStream | null {
    return this.stream;
  }

  async stop(): Promise<void> {
    this.node?.disconnect();
    this.source?.disconnect();
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    await this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
  }
}
