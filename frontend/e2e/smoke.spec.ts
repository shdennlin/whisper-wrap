import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Real-engine smoke: drives the zero-weights `whisper-wrap-server` (engine
// None, but it still serves /app/ + the session/status endpoints). Skipped
// cleanly when the binary is absent so the command still exits 0.
const here = dirname(fileURLToPath(import.meta.url));
const serverBin = resolve(
  here,
  "../../../engine/target/release/whisper-wrap-server",
);

test.describe("real-engine smoke", () => {
  test.skip(
    !existsSync(serverBin),
    "whisper-wrap-server binary absent — build it with `cargo build --release -p whisper-wrap-server` to run the smoke layer",
  );

  test("loads against the live zero-weights server and lists sessions", async ({
    page,
  }) => {
    // The genuine HTTP path: the server answers GET /v1/sessions with 200.
    const sessionsResp = page.waitForResponse(
      (r) => r.url().includes("/v1/sessions") && r.status() === 200,
    );
    await page.goto("");
    await sessionsResp;

    // The shell renders (the first-run gate may overlay it since no model is
    // loaded — the app-shell still mounts behind it).
    await expect(page.locator(".shell-sidebar")).toBeVisible();

    // Navigate by hash (no clicks, in case the gate overlays the nav) and
    // confirm the Library mounts against the live (empty) list.
    await page.goto("#/library");
    await expect(page.locator(".library-view")).toBeVisible();

    await page.goto("#/settings");
    await expect(page.locator(".settings-panel")).toBeVisible();
  });
});
