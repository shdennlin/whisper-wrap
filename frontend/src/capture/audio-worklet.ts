/**
 * AudioWorkletProcessor that downsamples raw mic Float32 input to 16 kHz
 * Int16 frames of 4000 samples (≈250 ms each at 16 kHz) and posts them
 * via `this.port`.
 *
 * The downsampler logic lives in `downsample.ts` as a pure function so it's
 * unit-testable without a real AudioContext.
 *
 * This file is loaded as a module URL by `mic-pipeline.ts` using Vite's `?url`
 * import.
 */

import { downsampleToInt16 } from "./downsample";

const FRAME_SAMPLES_16K = 4000;

class CaptureProcessor extends AudioWorkletProcessor {
  private buffer: number[] = [];

  override process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) {
      return true;
    }

    // sampleRate is the AudioContext's rate (globally available in the
    // AudioWorklet scope). Downsample this 128-sample chunk to 16 kHz Int16,
    // then accumulate until we have a full 4000-sample (250 ms) frame.
    const downsampled = downsampleToInt16(channel, sampleRate, 16000);
    for (let i = 0; i < downsampled.length; i++) {
      this.buffer.push(downsampled[i]);
    }

    while (this.buffer.length >= FRAME_SAMPLES_16K) {
      const slice = this.buffer.slice(0, FRAME_SAMPLES_16K);
      this.buffer = this.buffer.slice(FRAME_SAMPLES_16K);
      const frame = new Int16Array(slice);
      // Post the underlying ArrayBuffer transferable for zero-copy delivery.
      this.port.postMessage(frame.buffer, [frame.buffer]);
    }

    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
