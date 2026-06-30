import { expect, test } from "@playwright/test";
import { mockBackend } from "./helpers/mock-backend";
import { installTauriStub } from "./helpers/tauri-stub";

test.describe("app shell", () => {
  test.beforeEach(async ({ page }) => {
    await installTauriStub(page);
    await mockBackend(page);
  });

  test("loads the shell and navigates between views", async ({ page }) => {
    await page.goto("");

    const sidebar = page.locator(".shell-sidebar");
    await expect(sidebar).toBeVisible();

    // Every top-level nav entry renders.
    for (const view of ["home", "library", "models", "settings"]) {
      await expect(sidebar.locator(`.nav-item[data-view="${view}"]`)).toBeVisible();
    }

    // Library count reflects the mocked list (2 sessions + 0 meetings).
    await expect(
      sidebar.locator('.nav-item[data-view="library"] small'),
    ).toHaveText("2");

    // Navigating marks the active nav item and updates the hash.
    await sidebar.locator('.nav-item[data-view="library"]').click();
    await expect(page).toHaveURL(/#\/library$/);
    await expect(sidebar.locator('.nav-item[data-view="library"]')).toHaveClass(
      /active/,
    );

    await sidebar.locator('.nav-item[data-view="settings"]').click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.locator(".settings-panel")).toBeVisible();

    await sidebar.locator('.nav-item[data-view="models"]').click();
    await expect(page).toHaveURL(/#\/models$/);
  });
});
