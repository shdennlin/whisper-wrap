import { expect, test } from "@playwright/test";
import { mockBackend } from "./helpers/mock-backend";
import { installTauriStub } from "./helpers/tauri-stub";

test.describe("item detail", () => {
  test("renders transcript turns from the session finals", async ({ page }) => {
    await installTauriStub(page);
    await mockBackend(page);

    // Open the item that carries finals text directly by hash.
    await page.goto("#/item/sess-001");

    const turns = page.locator(".turn");
    await expect(turns).toHaveCount(2);
    await expect(turns.first()).toContainText(
      "Let's ship the overlay improvements today",
    );
    await expect(turns.nth(1)).toContainText("write the end to end tests");
  });
});
