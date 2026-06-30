import { describe, expect, it, vi } from "vitest";

import type { Item } from "../library/items";
import { deriveStats, renderSparkline } from "./home-stats";

// Fixed clock: 2026-06-12 15:00 local time.
const FIXED_NOW = new Date(2026, 5, 12, 15, 0).getTime();
const now = (): number => FIXED_NOW;

let nextId = 0;

function makeItem(daysAgo: number, durationMs: number | null): Item {
  nextId += 1;
  return {
    id: `item-${nextId}`,
    kind: "session",
    title: null,
    starred: false,
    project: null,
    category: null,
    // 10:00 local on the target day, so every item is mid-day and bucketing
    // is exercised purely by the local-calendar-day math.
    createdAt: new Date(2026, 5, 12 - daysAgo, 10, 0).getTime(),
    durationMs,
  };
}

describe("deriveStats", () => {
  it("buckets items into the right perDayMinutes slots, oldest first", () => {
    const items = [
      makeItem(0, 120_000), // today → slot 13, 2 min
      makeItem(1, 60_000), // yesterday → slot 12, 1 min
      makeItem(6, 180_000), // 6 days ago → slot 7, 3 min
      makeItem(13, 90_000), // 13 days ago → slot 0, 1.5 min
      makeItem(20, 600_000), // outside window: no slot, still a total item
    ];

    const stats = deriveStats(items, now);

    expect(stats.perDayMinutes).toHaveLength(14);
    expect(stats.perDayMinutes[13]).toBe(2);
    expect(stats.perDayMinutes[12]).toBe(1);
    expect(stats.perDayMinutes[7]).toBe(3);
    expect(stats.perDayMinutes[0]).toBe(1.5);
    const sum = stats.perDayMinutes.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(7.5);
    expect(stats.totalItems).toBe(5);
  });

  it("accumulates multiple items on the same local day", () => {
    const items = [makeItem(2, 60_000), makeItem(2, 90_000)];

    const stats = deriveStats(items, now);

    expect(stats.perDayMinutes[11]).toBe(2.5);
  });

  it("counts this-week items within the last 7 local days, today inclusive", () => {
    const items = [
      makeItem(0, 120_000), // today: counts, 2 min
      makeItem(6, 60_000), // exactly 6 days ago: counts, 1 min
      makeItem(8, 600_000), // 8 days ago: does NOT count toward the week
    ];

    const stats = deriveStats(items, now);

    expect(stats.itemsThisWeek).toBe(2);
    expect(stats.minutesThisWeek).toBe(3);
    expect(stats.totalItems).toBe(3);
  });

  it("counts a null-duration item as an item contributing 0 minutes", () => {
    const items = [makeItem(0, null), makeItem(1, 60_000)];

    const stats = deriveStats(items, now);

    expect(stats.itemsThisWeek).toBe(2);
    expect(stats.minutesThisWeek).toBe(1);
    expect(stats.perDayMinutes[13]).toBe(0);
    expect(stats.perDayMinutes[12]).toBe(1);
  });

  it("returns a zero-filled 14-slot array with no items", () => {
    const stats = deriveStats([], now);

    expect(stats.perDayMinutes).toHaveLength(14);
    expect(stats.perDayMinutes.every((v) => v === 0)).toBe(true);
    expect(stats.itemsThisWeek).toBe(0);
    expect(stats.minutesThisWeek).toBe(0);
    expect(stats.totalItems).toBe(0);
  });
});

describe("renderSparkline", () => {
  function makeStubbedCanvas(): {
    canvas: HTMLCanvasElement;
    ctx: {
      clearRect: ReturnType<typeof vi.fn>;
      beginPath: ReturnType<typeof vi.fn>;
      moveTo: ReturnType<typeof vi.fn>;
      lineTo: ReturnType<typeof vi.fn>;
      stroke: ReturnType<typeof vi.fn>;
    };
  } {
    const canvas = document.createElement("canvas");
    canvas.width = 140;
    canvas.height = 40;
    const ctx = {
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    };
    canvas.getContext = vi.fn(
      () => ctx,
    ) as unknown as HTMLCanvasElement["getContext"];
    return { canvas, ctx };
  }

  it("draws 14 values as one moveTo + 13 lineTo and strokes", () => {
    const { canvas, ctx } = makeStubbedCanvas();
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

    renderSparkline(canvas, values);

    expect(ctx.beginPath).toHaveBeenCalledTimes(1);
    expect(ctx.moveTo).toHaveBeenCalledTimes(1);
    expect(ctx.lineTo).toHaveBeenCalledTimes(13);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
  });

  it("draws a flat baseline when all values are zero (no NaN coordinates)", () => {
    const { canvas, ctx } = makeStubbedCanvas();

    renderSparkline(canvas, [0, 0, 0, 0]);

    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    const allCalls = [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls];
    for (const [x, y] of allCalls) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it("does not throw when getContext returns null (happy-dom default)", () => {
    const canvas = document.createElement("canvas");

    expect(() => renderSparkline(canvas, [1, 2, 3])).not.toThrow();
  });
});
