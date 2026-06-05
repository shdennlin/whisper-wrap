/**
 * Tests for the 48→16 kHz downsampler (Decision 2 of v2-4-pwa-listen-client).
 *
 * The downsampler is a pure function so we can unit-test it without an
 * AudioContext or AudioWorklet. The worklet code in `audio-worklet.ts` is a
 * thin shell that drives this function.
 */

import { describe, it, expect } from "vitest";
import { downsampleToInt16 } from "./downsample";

describe("downsampleToInt16", () => {
  it("passes through when source rate equals target", () => {
    const input = new Float32Array([0.0, 0.5, -0.5, 1.0, -1.0]);
    const out = downsampleToInt16(input, 16000, 16000);
    expect(out.length).toBe(input.length);
    // Float [-1, 1] maps to Int16 [-32768, 32767].
    expect(out[0]).toBe(0);
    expect(out[3]).toBe(32767);
    expect(out[4]).toBe(-32768);
  });

  it("downsamples 48 kHz → 16 kHz by a factor of 3", () => {
    // 12000 samples at 48 kHz = 0.25s; expect 4000 samples at 16 kHz.
    const input = new Float32Array(12000);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i / 100);
    const out = downsampleToInt16(input, 48000, 16000);
    expect(out.length).toBe(4000);
  });

  it("downsamples 44.1 kHz → 16 kHz within ±1 sample of expected length", () => {
    // 11025 samples at 44.1 kHz = 0.25s; expect ~4000 samples at 16 kHz.
    const input = new Float32Array(11025);
    for (let i = 0; i < input.length; i++) input[i] = 0.5;
    const out = downsampleToInt16(input, 44100, 16000);
    expect(out.length).toBeGreaterThanOrEqual(3999);
    expect(out.length).toBeLessThanOrEqual(4001);
  });

  it("clamps values outside [-1, 1] to Int16 range", () => {
    const input = new Float32Array([2.0, -2.0, 1.5, -1.5]);
    const out = downsampleToInt16(input, 16000, 16000);
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
    expect(out[2]).toBe(32767);
    expect(out[3]).toBe(-32768);
  });

  it("preserves DC offset (constant signal) at low rate ratio", () => {
    const input = new Float32Array(48000).fill(0.5);
    const out = downsampleToInt16(input, 48000, 16000);
    expect(out.length).toBe(16000);
    // Linear interpolation of a constant should yield the same constant.
    const expected = Math.round(0.5 * 32767);
    for (let i = 0; i < out.length; i++) {
      expect(Math.abs(out[i] - expected)).toBeLessThanOrEqual(1);
    }
  });
});
