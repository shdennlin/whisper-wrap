## Why

The current History panel has three structural problems that compound as users accumulate sessions:

1. **Layout cramp**: history lives in the right sidebar (~340 px wide). Transcripts and AI responses are reading content but the column is sized for controls — long content overflows the viewport and forces awkward outer-page scroll. After ~5 sessions the panel becomes hostile to use.
2. **AI runs are one-shot**: a session can have at most one stored `action_run` per Action template because the UI only fires on `actions-bar` click during recording. Users cannot retroactively run an Action against a past transcript, even though the backend `action_runs` table has no uniqueness constraint and the `/ask` endpoint accepts `{"text": "..."}` text-only input. Capability exists but is unreachable.
3. **No multi-run display**: even if `action_runs` had multiple rows per session, the panel would only render the first; there is no UI affordance for stacking, timestamping, or per-run deletion.

The fix is one coherent UX change because solving (1) without (2)(3) means re-doing the layout when re-run lands; solving (2)(3) without (1) makes the sidebar even denser.

## What Changes

- **History view becomes its own pseudo-route** (`#/history` and `#/history/:session_id`) so the panel can claim full viewport width without breaking the recording shell. The PWA shell renders the recording UI by default and switches to the History view when the hash matches.
- **Master-detail layout inside the History view**: left rail lists sessions (newest first, fuzzy search box on top); right panel shows the selected session's transcript, audio player, and all AI runs. Each scroll region has `max-height: 100%` + internal scrollbar so neither side scrolls the page.
- **Re-run AI Actions on past sessions**: detail panel exposes a "+ AI Action" button that opens the existing action picker. On confirm: the joined transcript is sent to `/ask` as text input (no audio), the answer is captured, and the result is POSTed to the existing `POST /v1/sessions/{id}/runs` endpoint, then re-rendered in the runs list.
- **Multiple action_runs per session**: the detail panel renders every row of `action_runs` for the selected session, sorted by `ran_at` descending, each with the action label, timestamp, the answer body, and a per-run delete button. Same Action template can appear multiple times (different timestamps).
- **Single-run deletion endpoint**: backend adds `DELETE /v1/sessions/{session_id}/runs/{run_id}` returning 204 on success, 404 when either id is unknown. Repo layer gets `delete_action_run(session, run_id) -> bool`.
- **HistoryStore frontend API extends**: existing `appendRun()` keeps writing; new `deleteRun(session_id, run_id)` removes via API + invalidates cache.
- **No data migration needed**: `action_runs` table already has an autoincrement `id` PK and no unique-by-action constraint, so existing rows render fine and new multi-run inserts just work.

## Non-Goals

- WebSocket `/listen` server-side persistence — the current client-driven model stays (per design discussion 2026-05-18: backend-side WS persistence costs auth + session correlation + incremental audio encoding for marginal benefit).
- Bulk export of action_runs across multiple sessions — single-session SRT/VTT/TXT export already exists and stays unchanged.
- Action template editor inside History view — the existing `registry/actions.yaml` workflow is unchanged.
- Server-side full-text search of finals — the fuzzy search box is client-side over the loaded session list (~20 sessions cap from existing eviction logic).
- Real client-side router (no `vue-router` / `react-router`). Hash-based pseudo-routing only, to keep `vite-plugin-pwa` `navigateFallback` config untouched.
- Action chip behaviour during live capture is unchanged. Only the history view gains the re-run affordance.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `pwa-listen-client`: History panel requirement is replaced — sidebar → master-detail pseudo-route with search + re-runnable AI Actions + multi-run display.
- `history-persistence`: REST API requirement gains a single-run delete endpoint; HistoryStore interface requirement gains `deleteRun()`.

## Impact

- Affected specs: `pwa-listen-client`, `history-persistence`
- Affected code:
  - New:
    - `frontend/src/ui/history-view.ts`
    - `frontend/src/ui/history-search.ts`
    - `frontend/src/ui/history-action-runs.ts`
    - `frontend/src/routing/hash-route.ts`
    - `frontend/src/ui/history-view.test.ts`
    - `frontend/src/ui/history-search.test.ts`
    - `frontend/src/routing/hash-route.test.ts`
  - Modified:
    - `frontend/src/ui/history-panel.ts` (becomes the master-detail container; loses card-list responsibility, gains detail-render responsibility)
    - `frontend/src/ui/history-panel.test.ts`
    - `frontend/src/storage/history-store.ts` (add `deleteRun`)
    - `frontend/src/storage/history-store.test.ts`
    - `frontend/src/storage/history-api-client.ts` (add `deleteActionRun` fetch wrapper)
    - `frontend/src/main.ts` (hash-route registration; History view mount)
    - `frontend/src/style.css` (master-detail flex layout, mobile collapse)
    - `frontend/src/i18n/strings.ts` (en + zh-TW: search placeholder, "+ AI Action", "Delete run", confirm dialog, empty-detail state, mobile back-button label)
    - `frontend/index.html` (one root container hook for view switcher, if not already present)
    - `app/api/sessions.py` (add `DELETE /v1/sessions/{session_id}/runs/{run_id}`)
    - `app/services/persistence/sessions_repo.py` (add `delete_action_run`)
    - `tests/test_sessions_api.py` (new endpoint tests)
    - `tests/test_persistence_models.py` (delete_action_run unit tests)
  - Removed: (none)
