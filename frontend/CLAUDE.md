# Frontend Agent Guide — whisper-wrap PWA

> **Audience: an AI agent making UI changes in this frontend** (typically driven by a
> designer doing visual fine-tuning). This file is auto-loaded when you work in
> `frontend/`. It is the **map + conventions + guardrails**; build/test commands live in
> [`README.md`](./README.md) (don't restate them, follow them).

This is a **Vite + vanilla TypeScript** PWA — **no React, no Svelte, no JSX**. Components
are hand-written TS that build DOM imperatively; state lives in stores; views subscribe.
Do not introduce a UI framework. (Rationale: the private umbrella's frontend-engineering notes.)

---

## Run it & see your change

From the **umbrella root** (the parent dir of `whisper-wrap/`):

```bash
make dev        # Vite HMR + engine; open  http://localhost:5173/app/   ← the dev URL
make server     # production: engine serves the built PWA at /app/
```

- Dev URL is **http://localhost:5173/app/** (Vite). The engine in `make dev` listens on
  **API_PORT 12000** (the Makefile sets it; `config.rs`'s bare default is 8000, but the
  integrated dev/desktop flows use 12000).
- Pure visual work without the umbrella: `cd frontend && bun run dev` (Vite at :5173,
  proxies the API to the engine, default backend :12000). Layout/CSS changes hot-reload
  instantly; calls needing the engine won't work until it's running.

**After any change, verify (see [`README.md`](./README.md) for exact commands):**
`bun run test` (vitest) · `bun x tsc --noEmit` (types) · `bun run lint` (biome) ·
optionally the Playwright `mocked` tier for visual/flow regression.

---

## View map — which file is which screen

Routes live in `src/routing/view-route.ts`; the route set is
`home · library · models · settings · license · overlay · detail`.

| Screen | File | What it is |
|--------|------|-----------|
| App frame / nav | `src/ui/app-shell.ts` | the shell: navigation, view switching, layout chrome |
| Home | `src/ui/home-view.ts` | landing / stats / entry point |
| Recording | `src/ui/recording-view.ts` | the live recording experience (largest view) |
| Library | `src/ui/library-view.ts` | history list of items/runs (star, delete, recent) |
| Detail | `src/ui/detail-view.ts` | a single item's transcript / runs / actions |
| Models | `src/ui/models-view.ts` | model registry / download management |
| Settings | `src/ui/settings-view.ts` + `src/ui/settings-panel.ts` | settings UI |
| License | `src/ui/license-view.ts` | desktop-only license activation/status (hidden on web via surface profile) |
| Global overlay | `src/overlay/` (`overlay-app.ts`, `overlay-capture.ts`, `overlay-waveform.ts`) | the floating quick-capture window (separate WebView surface) |

Many smaller components also live in `src/ui/` (e.g. `toast.ts`, `modal-prompt.ts`,
`inline-edit.ts`, `actions-bar.ts`, `waveform-player.ts`, `ai-action-modal.ts`,
`connection-indicator.ts`). Each screen/component has a **co-located `*.test.ts`** — when
you edit `foo.ts`, its `foo.test.ts` is your regression net; run it.

### Supporting domains (not screens — don't put UI here)

`src/capture/` recording pipeline (recorder, listen-socket, mode-store) ·
`src/library/` items/runs/session-events · `src/meeting/` meeting mode ·
`src/api/` engine API layer — the **generated typed client** (`client.ts` over
`src/api/generated/`, from the contract) that every domain module calls; don't hand-write
`fetch` to engine routes · `src/storage/` history client/store ·
`src/platform/` **WKWebView abstraction + Capability Registry** (see guardrails) ·
`src/health/` · `src/i18n/` · `src/theme/` · `src/export/` · `src/util/` · `src/types/`.

---

## Conventions (match these when generating code)

- **Styling**: keep visuals in CSS. Design tokens (colors/spacing/type/radius) are CSS
  variables; per-view styles belong with their view. Prefer editing CSS + the DOM
  structure over adding logic. *(Phase 0 (tracked in the private umbrella) splits the
  single `style.css` into `design-tokens.css` + per-view CSS; if that split has landed,
  follow it; if not, the global `src/style.css` is the current home.)*
- **The seam between visual and behavior**: semantic **class names** and **`data-*`
  attributes** are the contract. A visual change should touch markup/classes/CSS — not
  rename the `data-*` hooks that behavior code queries, and not move event/data logic.
- **State lives in stores** (`src/capture/*-store.ts`, `src/storage/`), views subscribe.
  Never stash state in the DOM. A pure visual change should not touch store logic.
- **Many small files > few large files.** A new component is a new `src/ui/<name>.ts`
  with a co-located `<name>.test.ts`.

---

## Guardrails (do not break these)

1. **Route native I/O through `src/platform/` helpers — never call the browser APIs
   directly.** In the Tauri desktop shell (WKWebView) the native `prompt`/`confirm`/
   `alert`, blob `<a download>`, and `navigator.clipboard` silently fail. Use the
   platform helpers: `platform/clipboard.ts`, `platform/save-file.ts`, and the
   modal/surface helpers. (This is a real, recurring breakage — see the project's
   WKWebView notes.)
2. **Premium / desktop-only code does NOT belong in this repo.** This is the public
   GPLv3 frontend. Premium features ship as **separate private surfaces** (e.g. the
   dictation overlay, which ships from a separate private surface as its own WebView
   window) — *not* as code in this bundle, and *not* behind a flag (a flag in a public
   bundle is patched out in two lines; the guarantee is that the premium *code* is
   private). For ordinary desktop-vs-web layout differences (non-premium), gate via the
   **surface seam**: `src/platform/surface.ts` (`SurfaceProfile`, `desktop | web`) +
   `src/platform/capability.ts` (Tauri shell detection — `isDesktopShell()` / `hasTauri()`).
   There is **no "capability registry / empty slot" mechanism** in this repo today. Don't
   add `if (isPro)` logic or premium UI to the public bundle. (Boundary rationale: see the
   private umbrella's product/boundary docs.)
3. **Don't introduce a UI framework or a heavy dependency.** Keep it vanilla TS + Vite.
4. **One bundle serves both web and desktop.** Don't assume a browser-only or
   desktop-only environment; gate desktop-only behavior through the Capability Registry.
5. **Run the touched view's `*.test.ts` + `tsc --noEmit` before declaring done.** The
   ~66 co-located tests guard behavior; a visual edit that breaks logic should turn them
   red, not ship.

---

## Where to look when unsure

- Build/test/run details, test tiers, macOS E2E limits → [`README.md`](./README.md).
- **Engine API contract** — endpoints, params, request/response shapes →
  [`../docs/openapi.json`](../docs/openapi.json), generated from the router (the
  machine-readable source of truth; feed it to a client generator or API explorer).
  Interactive explorer under `make dev`: **`http://localhost:12000/docs`** (the
  engine's own port, **dev builds only** — not Vite's `:5173`). Overview:
  [`../docs/API.md`](../docs/API.md).
  The frontend's engine client is **generated** from that contract
  (`src/api/generated/`) and consumed via `src/api/client.ts` — call
  `client.GET/POST(...)`, never hand-write `fetch`. After a contract change run
  `bun run gen:api` to regenerate; a vitest drift guard fails if it's stale.
- Frontend architecture decisions, designer collaboration model, open/closed boundary →
  the private umbrella's frontend-engineering notes.
- Manual verification walkthrough → [`CHECKLIST.md`](./CHECKLIST.md).
