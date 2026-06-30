import { expect, test } from "@playwright/test";
import { mockBackend } from "./helpers/mock-backend";
import { installTauriStub } from "./helpers/tauri-stub";

test.describe("library", () => {
  test("renders rows, the recent preview, and persists a star toggle", async ({
    page,
  }) => {
    await installTauriStub(page);
    await mockBackend(page);
    await page.goto("#/library");

    // Both fixture sessions are quick-capture rows.
    const rows = page.locator(".library-list .lib-row");
    await expect(rows).toHaveCount(2);

    // The sidebar recent shows the finals-derived preview of the newest item.
    await expect(page.locator(".shell-sidebar .recent-preview").first()).toContainText(
      "Let's ship the overlay",
    );

    // Star the un-starred item → optimistic ★ + a persisted PATCH.
    const star = page.locator('.lib-row[data-item-id="sess-001"] .library-star');
    await expect(star).toHaveText("☆");
    const patch = page.waitForRequest(
      (r) => r.method() === "PATCH" && r.url().includes("/v1/sessions/sess-001"),
    );
    await star.click();
    await patch;
    await expect(star).toHaveText("★");
  });

  test("deleting from detail removes the row from the library", async ({
    page,
  }) => {
    await installTauriStub(page);
    await mockBackend(page);
    await page.goto("#/library");
    await expect(page.locator(".library-list .lib-row")).toHaveCount(2);

    // Open the item, delete it (confirm the WKWebView-safe modal).
    await page.locator('.lib-row[data-item-id="sess-001"] .lib-row-text').click();
    await expect(page).toHaveURL(/#\/item\/sess-001$/);
    const del = page.waitForRequest(
      (r) => r.method() === "DELETE" && r.url().includes("/v1/sessions/sess-001"),
    );
    await page.locator(".detail-delete").click();
    await page.locator(".modal-prompt-ok").click();
    await del;

    // Back in the library, the deleted row is gone (mock removed it).
    await expect(page).toHaveURL(/#\/library$/);
    await expect(page.locator(".library-list .lib-row")).toHaveCount(1);
    await expect(
      page.locator('.lib-row[data-item-id="sess-001"]'),
    ).toHaveCount(0);
  });
});
