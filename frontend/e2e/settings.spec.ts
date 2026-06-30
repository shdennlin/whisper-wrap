import { expect, test } from "@playwright/test";
import { mockBackend } from "./helpers/mock-backend";
import { installTauriStub, tauriCalls } from "./helpers/tauri-stub";

test.describe("settings", () => {
  test("rebinds the global shortcut and records set_global_hotkey", async ({
    page,
  }) => {
    await installTauriStub(page);
    await mockBackend(page);
    await page.goto("#/settings");

    // Desktop-only rebind control renders because the Tauri stub makes
    // isDesktopShell() true. Scope to the global-hotkey button: overlay-auto-paste
    // added a paste-shortcut button that also carries `.settings-shortcut-btn`, so
    // the bare class now matches two elements.
    const btn = page.locator(
      ".settings-shortcut-btn:not(.settings-paste-shortcut-btn)",
    );
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText("⌥Space");

    // Enter capture mode, press ⌃⇧K.
    await btn.click();
    await expect(btn).toHaveClass(/is-capturing/);
    await page.keyboard.press("Control+Shift+K");

    await expect(btn).toHaveText("⌃⇧K");

    // The new binding was pushed to the shell.
    await expect
      .poll(async () =>
        (await tauriCalls(page)).some(
          (c) =>
            c.cmd === "set_global_hotkey" &&
            (c.args as { accelerator?: string })?.accelerator ===
              "Control+Shift+KeyK",
        ),
      )
      .toBe(true);
  });
});
