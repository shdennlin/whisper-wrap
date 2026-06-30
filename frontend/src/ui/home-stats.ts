/**
 * Pure stats derivation + sparkline rendering for the Home dashboard
 * (fe-home-dashboard).
 *
 * `deriveStats` buckets library items by LOCAL calendar day into a 14-slot
 * activity series (oldest first, today last) and tallies the trailing
 * 7-local-day week. Minute values are durationMs / 60_000 rounded to one
 * decimal place. "Today" always comes from the injected `now()` clock so the
 * function stays pure and testable.
 *
 * `renderSparkline` draws the series as a max-normalized polyline; an
 * all-zero series renders a flat baseline. Colors come from the canvas's
 * CSS custom properties with hard-coded fallbacks, and the bitmap is sized
 * from CSS pixels x devicePixelRatio (attribute size when clientWidth is 0,
 * as under happy-dom). A null 2D context is a silent no-op.
 */

import type { Item } from "../library/items";

export interface HomeStats {
  perDayMinutes: number[];
  itemsThisWeek: number;
  minutesThisWeek: number;
  totalItems: number;
}

const SPARK_DAYS = 14;
const WEEK_DAYS = 7;
const MS_PER_MINUTE = 60_000;
const ACCENT_FALLBACK = "#7c5cff";

function startOfLocalDay(epochMs: number): number {
  const d = new Date(epochMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Start of the local day `daysBack` days before the day containing `epochMs`. */
function startOfLocalDayMinus(epochMs: number, daysBack: number): number {
  const d = new Date(epochMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime();
}

function roundTenth(v: number): number {
  return Math.round(v * 10) / 10;
}

export function deriveStats(items: Item[], now: () => number): HomeStats {
  const nowMs = now();
  // Day-start timestamps for the 14-slot window, oldest first, today last.
  // Built via the Date constructor so DST transitions stay on calendar days.
  const dayStarts = Array.from({ length: SPARK_DAYS }, (_, i) =>
    startOfLocalDayMinus(nowMs, SPARK_DAYS - 1 - i),
  );
  const weekStart = startOfLocalDayMinus(nowMs, WEEK_DAYS - 1);

  const perDay = new Array<number>(SPARK_DAYS).fill(0);
  let itemsThisWeek = 0;
  let minutesThisWeek = 0;

  for (const item of items) {
    const minutes = item.durationMs != null ? item.durationMs / MS_PER_MINUTE : 0;
    const dayIndex = dayStarts.indexOf(startOfLocalDay(item.createdAt));
    if (dayIndex >= 0) perDay[dayIndex] += minutes;
    if (item.createdAt >= weekStart) {
      itemsThisWeek += 1;
      minutesThisWeek += minutes;
    }
  }

  return {
    perDayMinutes: perDay.map(roundTenth),
    itemsThisWeek,
    minutesThisWeek: roundTenth(minutesThisWeek),
    totalItems: items.length,
  };
}

export function renderSparkline(
  canvas: HTMLCanvasElement,
  values: number[],
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx || values.length === 0) return;

  const dpr = window.devicePixelRatio || 1;
  // happy-dom (and detached canvases) report clientWidth 0 — fall back to
  // the attribute size so tests and pre-layout renders still get a bitmap.
  const cssWidth = canvas.clientWidth > 0 ? canvas.clientWidth : canvas.width;
  const cssHeight =
    canvas.clientHeight > 0 ? canvas.clientHeight : canvas.height;
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  canvas.width = width;
  canvas.height = height;

  const accent =
    getComputedStyle(canvas).getPropertyValue("--accent").trim() ||
    ACCENT_FALLBACK;

  const pad = 2 * dpr;
  const innerWidth = width - 2 * pad;
  const innerHeight = height - 2 * pad;
  const max = Math.max(...values);
  const stepX = values.length > 1 ? innerWidth / (values.length - 1) : 0;

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5 * dpr;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  values.forEach((value, i) => {
    const x = pad + i * stepX;
    // All-zero series: max is 0, every point sits on the baseline.
    const norm = max > 0 ? value / max : 0;
    const y = pad + (1 - norm) * innerHeight;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
