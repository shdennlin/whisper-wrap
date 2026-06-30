/**
 * LiveWaveform — stream-fed time-domain waveform drawn while recording.
 *
 * `start(stream)` builds an AudioContext + AnalyserNode graph from the
 * MediaStream and paints the live curve each animation frame; `stop()`
 * tears everything down (cancel pending frame, close context, null the
 * internals) so repeated record sessions never leak audio resources.
 *
 * Failure policy: any throw during start (no AudioContext, bogus stream,
 * happy-dom returning null from getContext) leaves the waveform absent —
 * never rethrown, never toasted. Recording itself is unaffected.
 *
 * Accessibility: when prefers-reduced-motion is set at start time, a single
 * static centered bar is drawn instead and no animation loop is scheduled.
 */

const FALLBACK_STROKE = "#f7768e";

export interface LiveWaveform {
  start(stream: MediaStream): void;
  stop(): void;
}

export function createLiveWaveform(canvas: HTMLCanvasElement): LiveWaveform {
  let audioCtx: AudioContext | null = null;
  let rafId: number | null = null;

  function strokeColor(): string {
    const v = getComputedStyle(canvas).getPropertyValue("--rec").trim();
    return v || FALLBACK_STROKE;
  }

  function sizeCanvas(): void {
    // Size the bitmap from CSS pixels once per start. clientWidth is 0 in
    // happy-dom and for detached canvases — keep the attribute size then.
    const dpr = window.devicePixelRatio || 1;
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
    }
  }

  function drawStaticLevel(ctx2d: CanvasRenderingContext2D): void {
    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.strokeStyle = strokeColor();
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(w * 0.25, mid);
    ctx2d.lineTo(w * 0.75, mid);
    ctx2d.stroke();
  }

  function drawFrame(
    ctx2d: CanvasRenderingContext2D,
    node: AnalyserNode,
    data: Uint8Array<ArrayBuffer>,
    color: string,
  ): void {
    node.getByteTimeDomainData(data);
    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = Math.max(1, window.devicePixelRatio || 1);
    ctx2d.beginPath();
    const step = w / data.length;
    for (let i = 0; i < data.length; i++) {
      // Byte samples are 0-255 with 128 as silence — normalize to -1..1
      // around the vertical center.
      const v = (data[i] - 128) / 128;
      const y = mid + v * mid;
      const x = i * step;
      if (i === 0) {
        ctx2d.moveTo(x, y);
      } else {
        ctx2d.lineTo(x, y);
      }
    }
    ctx2d.stroke();
  }

  function start(stream: MediaStream): void {
    if (audioCtx) return;
    try {
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;
      sizeCanvas();

      const ctx = new window.AudioContext();
      audioCtx = ctx;
      const node = ctx.createAnalyser();
      node.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(node);

      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      if (reduced) {
        drawStaticLevel(ctx2d);
        return;
      }

      const data = new Uint8Array(node.frequencyBinCount);
      const color = strokeColor();
      const frame = (): void => {
        drawFrame(ctx2d, node, data, color);
        rafId = requestAnimationFrame(frame);
      };
      rafId = requestAnimationFrame(frame);
    } catch {
      // Waveform is cosmetic — absent on any failure, recording continues.
      stop();
    }
  }

  function stop(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (audioCtx !== null) {
      try {
        void audioCtx.close();
      } catch {
        // Closing an already-closed context throws in some browsers — ignore.
      }
      audioCtx = null;
    }
  }

  return { start, stop };
}
