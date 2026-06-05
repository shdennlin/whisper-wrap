/**
 * 48→16 kHz (or arbitrary rate → 16 kHz) downsampler.
 *
 * Pure function, no Web Audio dependency, so it's unit-testable in vitest
 * without an AudioContext. The AudioWorklet wraps this; the browser microphone
 * delivers samples at the device's native rate (typically 48 kHz on macOS,
 * 44.1 kHz on Windows) and `/listen` expects 16 kHz `pcm_s16le`.
 *
 * Linear interpolation is enough: speech occupies ≤8 kHz so we are downsampling
 * by 2-3×, well below the Nyquist limit, with no perceptible aliasing for
 * Whisper. A higher-order filter would burn CPU on the AudioWorklet thread
 * for inaudible gains.
 */

export function downsampleToInt16(
  input: Float32Array,
  sourceRate: number,
  targetRate = 16000,
): Int16Array {
  if (sourceRate === targetRate) {
    return floatToInt16(input);
  }
  if (sourceRate < targetRate) {
    throw new Error(
      `downsampleToInt16 only handles downsampling; got sourceRate=${sourceRate} < targetRate=${targetRate}`,
    );
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

function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = clampToInt16(input[i]);
  }
  return out;
}

function clampToInt16(sample: number): number {
  if (sample >= 1) return 32767;
  if (sample <= -1) return -32768;
  return Math.round(sample * 32767);
}
