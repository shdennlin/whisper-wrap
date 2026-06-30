import { describe, it, expect, vi } from "vitest";
import { refreshAllSurfaces } from "./refresh-surfaces";

describe("refreshAllSurfaces", () => {
  it("refreshes the shell sidebar and home dashboard together", () => {
    const shell = vi.fn();
    const home = vi.fn();

    refreshAllSurfaces({ shell, home });

    expect(shell).toHaveBeenCalledTimes(1);
    expect(home).toHaveBeenCalledTimes(1);
  });
});
