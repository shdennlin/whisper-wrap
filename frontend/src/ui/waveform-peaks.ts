/**
 * Compute two-level waveform peaks: for each of `columns` pixel columns,
 * return the min and max sample value of that bucket.
 *
 * Algorithm: linearly map samples to columns, then for each column scan its
 * sample range once. Output is `Array<[min, max]>` of length `columns`.
 *
 * Pixel buckets are evenly distributed; the last bucket includes any
 * remainder samples. Empty buckets (when columns > samples.length) emit
 * the single bucket sample, so the function never produces NaN.
 */

export function computePeaks(
  samples: Float32Array,
  columns: number,
): Array<[number, number]> {
  if (columns <= 0) return [];
  if (samples.length === 0) return [];

  const out: Array<[number, number]> = new Array(columns);
  const bucketSize = samples.length / columns;

  for (let c = 0; c < columns; c++) {
    const start = Math.floor(c * bucketSize);
    const end = c === columns - 1 ? samples.length : Math.floor((c + 1) * bucketSize);
    // Guard against zero-width buckets (columns > samples.length): clamp end so
    // we always inspect at least one sample.
    const lo = Math.min(start, samples.length - 1);
    const hi = Math.max(end, lo + 1);

    let min = samples[lo];
    let max = samples[lo];
    for (let i = lo + 1; i < hi; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[c] = [min, max];
  }
  return out;
}
