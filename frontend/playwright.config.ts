import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ESM config ("type": "module") — no implicit __dirname.
const here = dirname(fileURLToPath(import.meta.url));
const wwDir = resolve(here, ".."); // whisper-wrap/
const bundleDir = resolve(wwDir, "app/static/app"); // vite build output
// Engine now lives in-repo at whisper-wrap/engine/ — the e2e config is fully
// self-contained and no longer reaches up into the private umbrella.
const serverBin = resolve(wwDir, "engine/target/release/whisper-wrap-server");

const PREVIEW_PORT = 4173;
const SMOKE_PORT = 12790;
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}/app/`;
const SMOKE_URL = `http://localhost:${SMOKE_PORT}/app/`;

// The smoke project is opt-in (selected via --project=smoke) and gated on the
// engine binary existing. When absent it is skipped (see e2e/smoke.spec.ts), so
// the smoke webServer is only registered when it can actually run. Detect the
// selected project from argv (robust — bun's script runner can drop an inline
// env prefix); E2E_SMOKE=1 is also honored as an explicit override.
const wantSmoke =
  process.env.E2E_SMOKE === "1" ||
  process.argv.some((a) => a.includes("smoke"));
const haveServer = existsSync(serverBin);
const smokeTmp = resolve(tmpdir(), "ww-e2e-smoke");

// vite preview serves the built bundle at /app/. The build runs here (not in
// the npm script) so `playwright test --list` stays instant. With zero-weights
// the smoke server serves the same bundle dir, so it 404s until this build
// lands, then Playwright's URL health-check flips to 200.
const webServer: NonNullable<
  Parameters<typeof defineConfig>[0]["webServer"]
> = [
  {
    command: "bunx vite build && bunx vite preview --port 4173 --strictPort",
    url: PREVIEW_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
];

if (wantSmoke && haveServer) {
  webServer.push({
    command: serverBin,
    url: SMOKE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      API_PORT: String(SMOKE_PORT),
      REGISTRY_PATH: resolve(wwDir, "registry/models.yaml"),
      ACTIONS_PATH: resolve(wwDir, "registry/actions.yaml"),
      MODELS_DIR: resolve(smokeTmp, "models"), // empty → engine None (zero weights)
      DATA_DIR: resolve(smokeTmp, "data"),
      FRONTEND_DIR: bundleDir,
      RUST_LOG: "warn",
    },
  });
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    // Block the PWA service worker so it can never intercept requests ahead of
    // page.route() mocks, and so a precache can't serve a stale bundle.
    serviceWorkers: "block",
    trace: "on-first-retry",
    launchOptions: {
      // Synthetic mic so getUserMedia-touching flows run with no real device
      // and no permission prompt.
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  webServer,
  projects: [
    {
      name: "mocked",
      testIgnore: /smoke\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: PREVIEW_URL },
    },
    {
      name: "smoke",
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: SMOKE_URL },
    },
  ],
});
