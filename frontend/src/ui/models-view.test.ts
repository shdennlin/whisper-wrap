import { describe, expect, it, vi } from "vitest";

import { renderModels } from "./models-view";

describe("renderModels", () => {
  it("creates a host and mounts the model manager into it", () => {
    const container = document.createElement("div");
    const mount = vi.fn();
    renderModels(container, { mount });
    const host = container.querySelector(".models-host");
    expect(host).toBeTruthy();
    expect(mount).toHaveBeenCalledWith(host);
  });

  it("frames the host with a row title and an mrow card frame", () => {
    const container = document.createElement("div");
    renderModels(container, { mount: () => {} });
    expect(container.querySelector(".row-title h3")!.textContent).toBe("模型");
    const host = container.querySelector<HTMLElement>(".models-host")!;
    expect(host.parentElement!.classList.contains("mrow-frame")).toBe(true);
    // ASR section heading present.
    const sections = [...container.querySelectorAll(".models-section-title")].map((s) => s.textContent);
    expect(sections).toContain("轉錄 (ASR)");
  });

  it("mounts a second host for the auxiliary (diarization/VAD) manager", () => {
    const container = document.createElement("div");
    const mount = vi.fn();
    const mountAux = vi.fn();
    renderModels(container, { mount, mountAux });
    const hosts = container.querySelectorAll(".models-host");
    expect(hosts).toHaveLength(2);
    expect(mount).toHaveBeenCalledWith(hosts[0]);
    expect(mountAux).toHaveBeenCalledWith(hosts[1]);
  });
});
