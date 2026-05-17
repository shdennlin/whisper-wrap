/**
 * AudioWorkletProcessor that downsamples raw mic Float32 input to 16 kHz
 * Int16 frames of 4000 samples (~250 ms each) and posts them via `this.port`.
 *
 * Authored as plain `.js` (not `.ts`) so Vite's `?url` import emits it with the
 * `application/javascript` MIME type. With a `.ts` source Vite picks
 * `video/mp2t` (MPEG transport stream) and `AudioWorklet.addModule()` rejects
 * the script before running it. The downsampler math is intentionally inlined
 * here — sharing it with `downsample.ts` would require Vite to bundle the
 * worklet's imports, which `?url` does not do. Keep this file in sync with
 * `downsample.ts` if the algorithm ever changes.
 */

const FRAME_SAMPLES_16K = 4000;

function clampToInt16(sample) {
  if (sample >= 1) return 32767;
  if (sample <= -1) return -32768;
  return Math.round(sample * 32767);
}

function downsampleToInt16(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = clampToInt16(input[i]);
    }
    return out;
  }
  const ratio = sourceRate / targetRate;
  const outLength = Math.round(input.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const a = input[srcIdx] ?? 0;
    const b = input[srcIdx + 1] ?? a;
    const sample = a + (b - a) * frac;
    out[i] = clampToInt16(sample);
  }
  return out;
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) {
      return true;
    }

    const downsampled = downsampleToInt16(channel, sampleRate, 16000);
    for (let i = 0; i < downsampled.length; i++) {
      this.buffer.push(downsampled[i]);
    }

    while (this.buffer.length >= FRAME_SAMPLES_16K) {
      const slice = this.buffer.slice(0, FRAME_SAMPLES_16K);
      this.buffer = this.buffer.slice(FRAME_SAMPLES_16K);
      const frame = new Int16Array(slice);
      this.port.postMessage(frame.buffer, [frame.buffer]);
    }

    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
