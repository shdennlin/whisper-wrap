/**
 * Tests for `computePeaks` — buckets a decoded Float32Array into `columns`
 * pixel columns and returns one [min, max] pair per column.
 */

import { describe, it, expect } from "vitest";

import { computePeaks } from "./waveform-peaks";

describe("computePeaks", () => {
  it("returns exactly `columns` pairs", () => {
    const samples = new Float32Array(1000);
    const peaks = computePeaks(samples, 50);
    expect(peaks).toHaveLength(50);
  });

  it("returns [0, 0] for a constant-zero array", () => {
    const samples = new Float32Array(800);
    const peaks = computePeaks(samples, 20);
    for (const [min, max] of peaks) {
      expect(min).toBe(0);
      expect(max).toBe(0);
    }
  });

  it("captures peak amplitude in each bucket for a sine wave", () => {
    // Many cycles per bucket guarantees every bucket spans full +/- excursions.
    // 16 000 samples / 64 columns = 250 samples per bucket; with 256 cycles
    // that's 4 cycles per bucket — every bucket sees both extremes.
    const N = 16_000;
    const samples = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      samples[i] = Math.sin((2 * Math.PI * 256 * i) / N);
    }
    const peaks = computePeaks(samples, 64);
    expect(peaks).toHaveLength(64);
    for (const [min, max] of peaks) {
      expect(max).toBeGreaterThan(0.5);
      expect(min).toBeLessThan(-0.5);
    }
  });

  it("collapses a single sample per bucket when columns >= length", () => {
    const samples = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    const peaks = computePeaks(samples, 8);
    expect(peaks).toHaveLength(8);
    // For columns > samples.length, the function MUST NOT crash and SHALL
    // still produce one pair per requested column.
    for (const pair of peaks) {
      expect(pair).toHaveLength(2);
      expect(Number.isFinite(pair[0])).toBe(true);
      expect(Number.isFinite(pair[1])).toBe(true);
    }
  });

  it("returns empty array for columns <= 0", () => {
    const samples = new Float32Array([1, 2, 3]);
    expect(computePeaks(samples, 0)).toEqual([]);
    expect(computePeaks(samples, -5)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(computePeaks(new Float32Array(0), 10)).toEqual([]);
  });
});
