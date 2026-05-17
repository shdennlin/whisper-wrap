import { describe, expect, it } from "vitest";
import { formatTimer } from "./record-button";

describe("formatTimer", () => {
  it("starts at 0:00.0", () => {
    expect(formatTimer(0)).toBe("0:00.0");
  });

  it("renders tenths-of-second resolution", () => {
    expect(formatTimer(300)).toBe("0:00.3");
    expect(formatTimer(1200)).toBe("0:01.2");
    expect(formatTimer(12_345)).toBe("0:12.3");
  });

  it("rolls into minutes correctly", () => {
    expect(formatTimer(60_000)).toBe("1:00.0");
    expect(formatTimer(125_400)).toBe("2:05.4");
    expect(formatTimer(600_000)).toBe("10:00.0");
  });

  it("pads the seconds field to two digits", () => {
    expect(formatTimer(5_000)).toBe("0:05.0");
    expect(formatTimer(65_000)).toBe("1:05.0");
  });
});
