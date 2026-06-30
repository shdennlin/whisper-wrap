# whisper-wrap frontend

Vite + vanilla TypeScript PWA. One bundle serves both the web shell and the
Tauri desktop shell. Build output goes to `../app/static/app/` (served at
`/app/`). Use **bun**, never npm.

```bash
bun install        # install deps
bun run dev        # Vite dev server (HMR)
bun run build      # tsc --noEmit + vite build → ../app/static/app/
bun run lint       # biome lint
```

## Testing

Two complementary tiers:

### Unit / component — vitest (happy-dom)

```bash
bun run test       # the whole suite
bun x vitest run src/ui/home-view.test.ts   # one file
```

Fast, runs in a simulated DOM with the Tauri bridge, microphone, and `fetch`
all mocked. Owns `src/**/*.test.ts`. This tier has **no layout engine** — it
cannot see real rendering, layout, or navigation.

### End-to-end — Playwright (real Chromium)

Drives the built bundle in a real browser. Specs live in `e2e/`. First run
needs the browser: `bunx playwright install chromium`.

```bash
bun run test:e2e         # the "mocked" project (CI default)
bun run test:e2e:smoke   # the "smoke" project (real zero-weights engine)
```

- **`mocked`** — intercepts the engine endpoints with fixtures (`e2e/helpers/`)
  and injects a `window.__TAURI__` stub, then asserts the core UI flows
  (app-shell nav, Library star/delete/recent-preview, Detail transcript,
  Settings shortcut-rebind, the overlay route's start/stop/cancel). Deterministic,
  no server or model. Microphone uses Chromium's fake-media device.
- **`smoke`** — launches the real `whisper-wrap-server` binary against an empty
  models dir, so it boots **zero-weights** (no model) but still serves `/app/`
  and the session endpoints, and exercises the genuine HTTP path. It is
  **skipped cleanly** (exit 0) when the binary is absent; build it with
  `cargo build --release -p whisper-wrap-server` to run it.

#### Out of scope for E2E (macOS)

`tauri-driver` does not support macOS (WKWebView has no WebDriver), so the real
desktop shell and its native window behaviors **cannot** be driven by any
browser-WebDriver tool. These stay manual:

- the overlay floating **above a full-screen app** on the current screen,
- overlay **auto-focus** on open,
- the **global ⌥Space** shortcut and **cross-app Esc** cancel.

The E2E suite exercises the JS contract on the Rust↔JS boundary (via injected
events and a recorded-`invoke` stub), not the boundary itself.
