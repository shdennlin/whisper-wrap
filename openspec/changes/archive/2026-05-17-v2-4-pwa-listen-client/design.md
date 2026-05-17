## Context

whisper-wrap's `WS /listen` endpoint has been live since v2.0 and was hardened in v2.1 (partial-consensus filter) and v2.2 (silero-vad). The only existing client is `scripts/live-caption.py` — a CLI tool that captures from the local mic via `sounddevice` and renders text into the terminal. The deferred PWA in the v2 PRD was always meant to be the user-facing surface for this pipeline.

This change adds that PWA, plus a small backend capability for storing prompt-action templates server-side rather than in `localStorage`. Constraints inherited from the existing stack:

- **Single FastAPI process.** No separate web server. Static assets served from `app/static/app/` via `StaticFiles`.
- **LAN-only deployment model.** Already documented in `docs/INSTALLATION.md`. HTTPS is an optional Tailscale-cert overlay for users who want to reach the PWA from their phone.
- **`/listen` event protocol is frozen.** `{"type": "partial"|"final", "text", "start_ms", "end_ms"}` — the PWA consumes this verbatim. Any improvements to the protocol are separate changes.
- **Existing `/ask` blocking response shape stays.** The PWA uses the blocking path (`{"transcript": null, "answer": "..."}` with the text-JSON input). SSE streaming on `/ask` is not consumed by v1.
- **No third-party UI framework.** This is a small single-page app (transcript view + actions + history + settings ≈ 4 panes); a framework would add more code than it removes. Vanilla TypeScript with a thin `app-state.ts` module is enough.

## Goals

- Real-time captioning in a browser, partial-then-final UI, with the same caption quality the CLI gets today.
- Installable PWA with manifest + service worker so the shell + history are reachable when the backend is down.
- Server-side prompt action templates (YAML), fetched by the PWA on startup, used to wrap the transcript before POSTing to `/ask`.
- HTTPS via Tailscale documented and Makefile-supported so the PWA works on a phone over the tailnet.
- ≤ 4 days of total engineering, including the frontend build + docs + tests.

## Non-Goals

Recapitulated from proposal Non-Goals — restated here because design decisions reference them:

- No Refine (two-pass) button in v1.
- No transcript editing in v1.
- No SSE streaming consumption from `/ask`.
- No Web Speech API fallback.
- No multi-user / cloud sync / multi-language UI.

## Decisions

### Decision 1: Build tooling — Vite + vanilla TypeScript + vite-plugin-pwa

Considered: (a) Vite + React, (b) SvelteKit, (c) plain HTML+JS no bundler, (d) Vite + vanilla TS.

Chose **(d) Vite + vanilla TS**:

- The PWA has ~4 panes and no shared deep state — Redux/Pinia/etc. solve a problem we do not have.
- Vite gives us fast HMR, TypeScript out of the box, and `vite-plugin-pwa` auto-generates a Workbox service worker + manifest with sensible caching defaults.
- The bundle stays small (~50 KB raw / ~15 KB gzipped without framework code) which matters for mobile-over-Tailscale.
- vanilla TS keeps the learning surface for future-me small — no framework upgrade churn.

Reject (a) React: ~40 KB of framework before we write any code; we do not benefit from JSX for this size of app.
Reject (b) SvelteKit: solid choice but adds server-side rendering machinery we do not need (FastAPI hosts the static bundle, not SvelteKit's adapter).
Reject (c) no bundler: TypeScript without a build step means hand-writing ES modules and managing the service worker by hand. The cost of `vite` is essentially zero.

### Decision 2: Audio capture pipeline — AudioWorklet + manual 48→16 kHz downsampling

The browser microphone delivers ~48 kHz Float32 PCM. `/listen` expects 16 kHz signed-16-bit mono PCM frames of 200–65 536 bytes.

The pipeline:

```
getUserMedia({audio: {sampleRate: 16000 ideally, channelCount: 1}})
    ↓ (browser may ignore sampleRate hint — it's a hint, not a guarantee)
AudioContext (whatever rate it gave us, typically 48000)
    ↓
AudioWorkletNode running a downsampler:
    - if rate == 16000: pass through
    - if rate != 16000: linear-interpolation downsample to 16 kHz
    ↓
Float32 buffer → Int16 little-endian conversion
    ↓ chunk into 4000-sample (8000-byte, 250 ms) frames
WebSocket.send(ArrayBuffer)
```

Considered using the `MediaRecorder` API + Opus. Rejected: `/listen` does not accept Opus and adding server-side Opus decode is a much larger change than 30 lines of downsampling JS.

Considered offloading downsampling to OfflineAudioContext. Rejected: that's batch-only; we need streaming.

Considered keeping the source rate and asking `/listen` to accept arbitrary rates. Rejected: spec is frozen and changing it ripples through whisper.cpp / faster-whisper / silero-vad assumptions.

### Decision 3: WebSocket reconnect strategy

On unexpected close (anything other than the user pressing Stop), the PWA reconnects with exponential backoff:

| Attempt | Delay (ms) |
| ------- | ---------- |
| 1       | 1 000      |
| 2       | 2 000      |
| 3       | 4 000      |
| 4       | 8 000      |
| 5+      | 16 000     |

Maximum 10 attempts before giving up and showing a red banner with a manual Retry button. The connection indicator goes yellow during reconnect, red after exhaustion, green on success.

Critical invariant: **already-confirmed finals are preserved across reconnects.** The reconnect loop only loses the in-flight partial (which by definition was not stable yet). The new connection starts a fresh `start_ms=0` reference — the PWA tracks a per-session offset and adds it to incoming `start_ms`/`end_ms` so SRT export remains globally monotonic.

Considered no backoff (instant retry). Rejected: hammers the server during whisper-wrap restart.
Considered infinite retries. Rejected: silent indefinite reconnects mask "I forgot to start whisper-wrap" — better to surface the failure after ~1 minute.

### Decision 4: History persistence — incremental localStorage write per final, capped at 20 sessions

A capture session starts on record-press and ends on stop-press. The session record:

```ts
type Session = {
  id: string;                  // ULID (timestamp-orderable, no collision risk)
  started_at: number;          // ms epoch
  ended_at: number | null;     // null while recording; set on stop
  finals: Array<{
    text: string;
    start_ms: number;
    end_ms: number;
  }>;
  action_runs: Array<{
    action_id: string;
    prompt: string;
    answer: string;
    ran_at: number;
  }>;
};
```

Storage: `localStorage` under a single key `whisper-wrap.sessions`. On every `final` event, the PWA mutates the in-memory current session and re-serialises the entire list. The list is capped at 20 — when adding a new session, drop the oldest. (`localStorage` ceiling is ~5 MB; 20 sessions × ~2 KB each is ~40 KB, comfortably under any browser limit.)

This is the "incremental write per final" decision: a 2-hour meeting that ends in a browser crash still has the finals up to the crash point saved. Without incremental writes, the user would lose the entire session.

Considered IndexedDB. Rejected: more code, async API, no functional benefit at our data scale.
Considered "write on stop only." Rejected: defeats the purpose of crash protection.
Considered configurable cap (5 / 10 / 20). Adopted: surfaced in the Settings panel; default 20.

### Decision 5: Action templates — backend YAML at registry/actions.yaml, fetched once per page load

The Action templates live on the backend, not in `localStorage`, because:

1. The user described them as "things I edit" — editing YAML on the server is what they actually want, not a UI.
2. Templates are reusable across devices (today: just your Mac, but tomorrow: you and phone share whatever's on the server).
3. They version-control naturally (the YAML lives in the repo).

YAML schema:

```yaml
actions:
  - id: passthrough            # required, kebab-case, unique
    label: 直接送                # required, display string (UTF-8)
    template: "{transcript}"   # required, must contain the literal {transcript} placeholder
  - id: cleanup
    label: 加標點 / 改寫流暢
    template: |
      請把以下逐字稿加上適當的標點、修掉口語贅字（嗯、對、然後…），
      但保持原意和語氣，不要重新組織段落。
      
      {transcript}
  - id: summarize
    label: 整理會議重點
    template: |
      請把以下會議內容整理成條列式重點，每條一行，保留發言者口吻。

      {transcript}
  - id: translate-en
    label: 翻譯成英文
    template: "Translate the following Chinese transcript to natural English:\n\n{transcript}"
  - id: formalize
    label: 改寫得更專業
    template: |
      請把以下口語逐字稿改寫成適合書面溝通的正式語氣。

      {transcript}
```

The backend endpoint `GET /actions` returns `{"actions": [{"id", "label", "template"}, ...]}`. The PWA fetches this once on load, caches it in memory for the page lifetime, and re-fetches on full reload (so editing the YAML + restarting whisper-wrap is the editing loop).

Considered: PWA UI for editing actions. Rejected: user explicitly wants YAML on backend.
Considered: per-user actions. Rejected: single-user tool, no auth, no concept of "user."
Considered: server-side template wrapping (PWA sends `transcript` + `action_id`, backend wraps). Rejected: makes `/ask` aware of `/actions`, couples two endpoints that should stay independent. The PWA wrapping `{transcript}` substitution client-side keeps `/ask` a pure "here is a prompt, run it" surface.

### Decision 6: PWA mount path — `/app/` on the same FastAPI host

FastAPI's `StaticFiles` mounts at `/app/`. The PWA hits the API at `window.location.origin` (so `http://localhost:8000` or `https://mac-mini.tailXXXXX.ts.net`) for `/listen`, `/ask`, `/actions`. No CORS configuration needed — same origin everywhere.

Considered: hosting the PWA on a separate port (e.g. Vite dev server on `:5173`). Rejected: ergonomically worse (two URLs to remember), requires CORS, breaks the "single process" promise.
Considered: serving the PWA at root (`/`). Rejected: that's already the JSON endpoint catalogue. Keeping `/` for the catalogue and `/app/` for the UI is clearer.

### Decision 7: HTTPS deployment — optional, via Tailscale cert + uvicorn ssl flags

Two deployment shapes documented:

- **Localhost only** (default): `make dev` → `uvicorn` on `http://0.0.0.0:8000`. The PWA works from the Mac mini's own browser. Mic permission OK because `localhost` is treated as secure.
- **Tailscale + HTTPS** (phone / iPad usage): user runs `tailscale cert mac-mini.<tailnet>.ts.net` once, gets `.crt` and `.key`, sets `WHISPER_CERT` / `WHISPER_KEY` env vars, runs `make dev-https`. Cert renewal is a cron / launchd one-liner the user manages (we document the recipe but do not automate it for them — the user has only one machine; over-automation is overhead).

`docs/HTTPS-TAILSCALE.md` covers: enabling MagicDNS + HTTPS in Admin Console; running `tailscale cert`; configuring uvicorn; cert renewal; troubleshooting common failures (cert not trusted on Android, MagicDNS not propagating). The doc is independent of the PWA — anyone else running whisper-wrap on a tailnet benefits.

## Implementation Contract

This change introduces both a new build pipeline (frontend) and new runtime endpoints (actions). The contract below names what apply must deliver — re-read it before claiming a task complete.

### Frontend (PWA shell)

**Deliverable.** A static build under `frontend/dist/` that, when copied to `app/static/app/` and served by FastAPI at `/app/`, presents a working SPA with:

- record / stop button that captures mic audio and streams it to `WS /listen`
- live transcript view with greyed-out partials and confirmed (black) finals, time-aligned
- connection indicator (green / yellow / red)
- Actions chip bar populated from `GET /actions`, with a Run-Action button that POSTs `{"text": <wrapped-transcript>}` to `/ask` and renders the answer below the transcript
- history panel listing the last 20 sessions, Copy / Export / Delete buttons per session
- settings panel with mic device picker, partial-display toggle, auto-scroll toggle, retention count, dark-mode follow OS

**Manifest contract.** `frontend/public/manifest.webmanifest` includes `name: "whisper-wrap"`, `short_name: "wwrap"`, `start_url: "/app/"`, `display: "standalone"`, `theme_color`, `background_color`, icon entries pointing at the 192 and 512 PNGs in `public/icons/`.

**Service worker contract.** Generated by `vite-plugin-pwa`. Cache strategy:
- `staleWhileRevalidate` for `/app/` static assets (HTML/JS/CSS/icons/manifest)
- `networkOnly` (no caching) for `/listen`, `/ask`, `/actions`, `/transcribe`, `/status`, `/v1/...` — backend calls always hit the live server.

**Failure modes the PWA SHALL handle gracefully (each one is a test case):**
- mic permission denied → friendly modal pointing at browser settings, no JS error
- `getUserMedia` not available (insecure origin) → friendly banner explaining HTTPS / localhost rule
- WebSocket initial connect fails → red indicator + retry button after backoff exhaustion
- `/actions` 404 / 5xx → fall back to a built-in `passthrough` action only, show a warning toast
- `/ask` fails (LLM not configured) → render the error message text in the answer pane, do not crash the action UI

### Backend (`prompt-actions`)

**`registry/actions.yaml`** ships with the 5 built-in actions listed in Decision 5. The file MUST validate at startup; if missing or malformed, the server SHALL emit a one-line WARNING and serve an empty actions list (the PWA falls back to its built-in passthrough).

**Loader contract** (`app/services/actions.py`): exposes `load_actions(path: Path) -> list[ActionTemplate]` where `ActionTemplate` is a dataclass with `id: str`, `label: str`, `template: str`. Validation rules — duplicate `id` is a load error, missing `{transcript}` in `template` is a load error.

**HTTP contract** (`app/api/actions.py`): `GET /actions` returns HTTP 200 with body `{"actions": [{"id", "label", "template"}, ...]}`. Reachable without authentication. No write endpoints (the YAML is the edit surface).

### Endpoint catalogue update (`status` capability)

`GET /` adds two rows: `{"method": "GET", "path": "/actions", "description": "Prompt action templates registry"}` and `{"method": "GET", "path": "/app/", "description": "PWA live-captioning client"}`.

### HTTPS deployment

`Makefile` gains a `dev-https` target that requires `WHISPER_CERT` and `WHISPER_KEY` env vars and runs `uvicorn ... --ssl-certfile $WHISPER_CERT --ssl-keyfile $WHISPER_KEY`. The target fails with a clear message if either var is unset.

`docs/HTTPS-TAILSCALE.md` walks through: enable HTTPS in Tailscale Admin Console, run `tailscale cert`, set env vars, run `make dev-https`, set up cert renewal.

**Scope notes:**

In scope —
- All deliverables in the four blocks above
- Vitest unit tests for `subtitle-export.ts`, `history-store.ts`, and the AudioWorklet downsampler
- Python pytest tests for `app/services/actions.py` (YAML loader edge cases) and `app/api/actions.py` (HTTP contract)
- Playwright (or similar) is NOT required — manual checklist documented in tasks.md is sufficient for v1

Out of scope —
- Two-pass Refine button
- Transcript editing
- Streaming `/ask` consumption
- E2E browser test automation
- Editing the actions YAML via UI
- Multi-language UI

## Risks / Trade-offs

| Risk | Mitigation |
| - | - |
| 48→16 kHz downsampling on the main browser thread introduces audio glitches at high CPU load. | Run downsampling in an AudioWorklet (separate thread). Linear interpolation is cheap (~10 µs per 250 ms frame). If glitches surface, fall back to `audio.sampleRate` direct sampling via `AudioContext({sampleRate: 16000})` even though browsers may ignore the hint. |
| The PWA tab going to background causes the AudioWorklet to throttle, dropping audio. | Acceptable for a foreground tool — user is staring at the transcript anyway. Document the constraint in the Settings page help text. Consider a `wakeLock` request in v1.1 if needed. |
| Service worker caching causes "I deployed a fix but the PWA still shows old code." | `vite-plugin-pwa` uses content-hashed asset URLs and a versioned SW. Cache busts automatically on rebuild. User sees a "New version available, reload?" toast (vite-plugin-pwa built-in). |
| Browsers report `getUserMedia` errors with non-standard error names. | Catch broadly, present "mic permission denied" generically with a deep link to MDN's "fix this in your browser settings" if available. |
| The YAML loader silently dropping an action with a bad `{transcript}` placeholder leaves the user confused. | Loader raises on bad templates; the server starts up but emits a WARNING with the offending action id, and `/actions` returns the remaining valid entries. The PWA shows a "1 action skipped due to error" banner if `/actions` returns a `warnings` field — _optional v1.1_, plain skip in v1. |
| Tailscale cert renewal is the user's responsibility — they will forget. | Document a launchd plist template in `docs/HTTPS-TAILSCALE.md` that auto-renews every 60 days. User installs it once. |
| Frontend build needs Node — adds a dev dependency the Python-only stack didn't have. | Document Node 20+ in `docs/INSTALLATION.md` next to the existing system deps list. The frontend dist is committed to the repo so users who skip the frontend build still get a working PWA from a `git pull` — but commit is gated on `make build-frontend` in the developer's loop (added as a Make target, not enforced in CI for v1). |

## Migration Plan

This is purely additive — no existing endpoint, file, or behaviour changes shape. No rollback needed; if the PWA breaks, the user keeps using `scripts/live-caption.py`.

Deploy order:
1. Land `prompt-actions` (YAML + `/actions` endpoint + status catalogue entry). Whisper-wrap can ship this without the PWA and the backend is healthy.
2. Land the frontend build + StaticFiles mount. PWA is reachable at `/app/`.
3. Land `docs/HTTPS-TAILSCALE.md` + `make dev-https`. Optional adoption.

For the user: pull the repo, run `make setup` (which now includes `make build-frontend`), open `http://localhost:8000/app/` in a browser. If the browser asks for mic permission and the transcript shows up, you're done.

## Open Questions

- Should the PWA show a "you're not on HTTPS — mic will not work outside localhost" banner up-front, or wait for the user to press record and fail? Picking: up-front banner if `window.isSecureContext === false` and `window.location.hostname !== "localhost"`, otherwise no banner.
- Should the Action templates allow a `system_prompt` override per action? `/ask` already uses `GEMINI_SYSTEM_PROMPT`. Picking: NO for v1. Per-action system prompts can come if users ask. The current `{transcript}` placeholder system is enough for "wrap the transcript with intent."
- Should we vendor the PWA icons (192/512 PNG) or generate them from an SVG at build time? Picking: vendor them. Two PNGs in the repo is simpler than a build step. Will use a minimal generated wave-glyph; reroll later if the design is ugly.
