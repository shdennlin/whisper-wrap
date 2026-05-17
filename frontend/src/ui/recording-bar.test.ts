import { describe, expect, it } from "vitest";
import { formatTimer } from "./recording-bar";

describe("formatTimer (recording-bar)", () => {
  it("starts at 0:00.0", () => {
    expect(formatTimer(0)).toBe("0:00.0");
  });

  it("renders tenths-of-second resolution under one minute", () => {
    expect(formatTimer(300)).toBe("0:00.3");
    expect(formatTimer(12_345)).toBe("0:12.3");
    expect(formatTimer(59_900)).toBe("0:59.9");
  });

  it("rolls over to mm:ss.x past one minute", () => {
    expect(formatTimer(60_000)).toBe("1:00.0");
    expect(formatTimer(125_400)).toBe("2:05.4");
    expect(formatTimer(600_000)).toBe("10:00.0");
  });
});
