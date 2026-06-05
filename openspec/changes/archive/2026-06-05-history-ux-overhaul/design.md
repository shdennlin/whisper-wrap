## Context

The History panel currently lives inside `frontend/src/ui/history-panel.ts` and is mounted by `frontend/src/main.ts` as a fixed sidebar element. The PWA shell renders the recording controls in the centre with the history strip on the right. The data layer is already API-backed (since the SQLite migration in `history-persistence-sqlite`): `HistoryStore` keeps an in-memory `Map<string, SessionRecord>` cache and proxies all writes to `/v1/sessions/...`.

Three forces drive this design:

- **PWA constraint**: `vite-plugin-pwa` is configured with a generated service worker (`registerType: "autoUpdate"`) and a `navigateFallback` to `index.html`. Introducing a real client-side router (history API) means teaching the SW about route exclusions; hash-based routing sidesteps this entirely.
- **Data model freedom**: the persisted `action_runs` table has `id INTEGER PRIMARY KEY AUTOINCREMENT` and no composite unique on `(session_id, action_id)`. Multi-run-per-session is already legal at the DB layer — the gap is purely UI plus a delete endpoint.
- **Single-writer FastAPI**: all DB access is synchronous through the existing `SessionLocal` sessionmaker. The DELETE endpoint follows the same pattern as `DELETE /v1/sessions/{id}` already in `app/api/sessions.py`.

Stakeholders: solo end user (this PWA's only consumer). No backwards-compat constraints for client code since the PWA is the only known consumer of `/v1/sessions/*`.

## Goals / Non-Goals

**Goals**

- Replace the cramped sidebar with a master-detail History view that scales to long transcripts and many AI runs.
- Enable retroactive AI Action runs against any persisted session's transcript.
- Render multiple `action_runs` per session in stacked, time-ordered form with per-run deletion.
- Keep the existing `HistoryStore` public surface intact; only add `deleteRun`.
- Keep the existing recording shell unaffected when the user is not viewing history.
- Maintain offline-shell capability — the History view SHALL render from cache when reachable.

**Non-Goals**

- WS `/listen` server-side persistence (explicitly out per discussion 2026-05-18).
- Cross-session bulk export.
- Action template authoring inside the History view.
- Server-side full-text search of finals.
- Real client-side router or framework adoption.

## Decisions

### Decision 1: Hash-based pseudo-routing over History API

**Chosen**: Listen on `window.addEventListener("hashchange", ...)` and parse `location.hash`. Two routes: `#/history` (list, no selection) and `#/history/<session_id>` (with selection). Empty hash or any other value → recording shell.

**Why**: Zero service-worker configuration churn. `vite-plugin-pwa`'s `navigateFallback: "index.html"` continues to map every same-path request to the SPA shell; hash fragments never leave the client. Existing offline-shell caching tests in `tests/` need no update.

**Alternative — History API + SW route allowlist**: Would require `workbox.navigateFallbackDenylist: [/^\/api/, /^\/v1/, /^\/static/, /^\/app\/(?!history)/]` plus integration tests for the new routing layer. Adds 3-5 hours of yak-shaving for negligible URL beauty gain on a single-tenant PWA.

### Decision 2: Master-detail in a single container, not nested routes

**Chosen**: `HistoryView` renders both rail and detail in one component. When no `:session_id` is in the hash, detail panel shows an empty state ("Select a session"). When a `:session_id` is present, detail renders that session's transcript + runs.

**Why**: Two routes (`#/history` vs `#/history/:id`) keep URL semantics clear, but we avoid the complexity of nested-component lifecycle by treating the rail as always-mounted within the view and only the detail varies. Mobile collapse: on viewports <= 768 px the rail and detail occupy the full width and toggle; the toggle is driven by whether a `:session_id` is present.

**Alternative — separate rail and detail components mounted independently**: Possible but adds prop-drilling for the selected-id state across two component boundaries. The single-container approach reads cleaner.

### Decision 3: Fuzzy search is client-side over the loaded session list

**Chosen**: Match against `session.started_at` (formatted as `YYYY-MM-DD HH:MM`), and the concatenated `finals[].text`. Use a simple case-insensitive `String.prototype.includes` over a precomputed haystack per session, debounced to 120 ms on input. No fancy library.

**Why**: Existing eviction rule caps the list at 20 sessions; the haystack for 20 sessions of 5-minute transcripts is ~50-100 KB total — well under any threshold where smarter indexing matters. A debounced `includes` filter rebuilds the visible rail in <1 ms on Tier-1 phones.

**Alternative — fuse.js or fzf-style scoring**: Real fuzzy match (typo tolerance) is unnecessary when content is short, exact, and viewable in one scroll. Adding a search library costs 4-8 KB gzipped for marginal UX gain.

### Decision 4: Re-run flow uses `/ask` text-only mode, not a new endpoint

**Chosen**: When the user picks an Action in the detail panel, the frontend POSTs to existing `/ask` with body `{"text": "<prompt>"}` where `<prompt>` is the action template applied to the joined transcript text (same templating as the actions-bar already does — see `frontend/src/ui/actions-bar.ts`). On success, POST the answer to `POST /v1/sessions/{id}/runs`.

**Why**: `/ask` already supports text-only input (skips STT entirely) and already streams or blocking-returns the Gemini answer. No new backend endpoint, no new error path. The persistence call is the same one the actions-bar uses live.

**Alternative — a single new endpoint `POST /v1/sessions/{id}/runs:execute` that does ask + persist atomically**: Atomicity sounds nice but on failure-of-persist the answer is gone, which is worse than the current "ask succeeded, retry persist" path. Two-step is more recoverable.

### Decision 5: DELETE endpoint shape

**Chosen**: `DELETE /v1/sessions/{session_id}/runs/{run_id}`. Returns 204 on success, 404 when either the session or the run is unknown, 404 when the run exists but belongs to a different session.

**Why**: Matches the existing convention in `app/api/sessions.py` for `DELETE /v1/sessions/{id}` (204 / 404). The composite-path form (session + run) prevents authorization confusion in any future multi-tenant world — a run id alone could leak cross-session.

**Alternative — `DELETE /v1/runs/{run_id}`**: Shorter but ambiguous about session context. Rejected.

## Implementation Contract

### 1. Hash routing module (`frontend/src/routing/hash-route.ts`)

**Exports**:

- `type ParsedRoute = { name: "shell" } | { name: "history"; sessionId: string | null }`
- `parseHash(hash: string): ParsedRoute` — pure function; `""` or `"#"` → `{name: "shell"}`; `"#/history"` → `{name: "history", sessionId: null}`; `"#/history/<id>"` → `{name: "history", sessionId: <id>}`; anything else → `{name: "shell"}`.
- `onRouteChange(handler: (route: ParsedRoute) => void): () => void` — registers `hashchange`; returns unsubscribe.
- `navigateToHistory(sessionId?: string): void` — sets `location.hash` to `#/history` or `#/history/<id>`.

**Behavior**: parsing is total (never throws). `onRouteChange` fires synchronously on register with the current route so consumers don't miss the initial state.

**Verification target**: `frontend/src/routing/hash-route.test.ts` covers each route shape, malformed input, and synchronous initial-fire behavior.

### 2. History view component (`frontend/src/ui/history-view.ts`)

**Public API**:

```ts
export interface HistoryViewOptions {
  root: HTMLElement;
  store: HistoryStore;
  resolveActionLabel?: (id: string) => string | null;
  reAsrDeps?: ReAsrFormDeps;
  reAsrDefaults?: () => ReAsrFormDefaults;
  getAudio?: (session_id: string) => Promise<StoredAudio | null>;
  runActionAgain: (sessionId: string, actionId: string, prompt: string) => Promise<string>;
}

export class HistoryView {
  constructor(opts: HistoryViewOptions);
  show(sessionId: string | null): void;
  hide(): void;
  destroy(): void;
}
```

**Behavior**:

- `show(null)`: render the master-detail layout with rail populated, detail panel showing empty state.
- `show(<id>)`: render with the matching session selected and detail populated. Unknown id → empty state with "Session not found" message.
- `hide()`: remove its DOM nodes; keeps registered listeners off.
- Search box at the top of the rail filters the displayed sessions (Decision 3).
- Rail row click sets `location.hash` to `#/history/<id>` (the rail does NOT call `show` directly — the route is the source of truth).
- Detail panel includes: meta (date / duration / word count), waveform player, transcript body, action-runs list (newest first), "+ AI Action" button.
- "+ AI Action" opens the existing action picker UI (reuse `frontend/src/ui/actions-bar.ts` picker or extract to a shared component); on confirm calls `runActionAgain`, then re-renders the runs list.
- Each action-run row has a Delete button. Click → confirm dialog (i18n string `history.deleteRunConfirm`) → `store.deleteRun(sessionId, runId)` → re-render.

**Verification target**: `frontend/src/ui/history-view.test.ts` covers: empty rail state, search filtering, session selection rendering, multi-run rendering ordered by `ran_at desc`, "+ AI Action" flow with mocked `runActionAgain`, delete-run flow with mocked store, mobile collapse breakpoint.

### 3. HistoryStore additions (`frontend/src/storage/history-store.ts`)

**New method**:

```ts
async deleteRun(sessionId: string, runId: number): Promise<void>
```

**Behavior**:

- POSTs `DELETE /v1/sessions/<sessionId>/runs/<runId>` via `history-api-client.ts::deleteActionRun`.
- On 204: removes the run from the cached session's `action_runs` array.
- On 404: surfaces a `HistoryApiError` with `status: 404`; caller's `onError` toast handles the message.
- Other errors: surfaced via `HistoryApiError`; cache unchanged.

**Verification target**: `frontend/src/storage/history-store.test.ts` cases for 204 cache-eviction, 404 cache-untouched, network-error cache-untouched.

### 4. API client wrapper (`frontend/src/storage/history-api-client.ts`)

**New function**:

```ts
async deleteActionRun(backendUrl: string, sessionId: string, runId: number): Promise<void>
```

**Behavior**: thin fetch around `DELETE ${backendUrl}/v1/sessions/${sessionId}/runs/${runId}`; throws `HistoryApiError` on non-204; resolves void on 204.

### 5. Backend DELETE endpoint (`app/api/sessions.py`)

**Route**: `DELETE /v1/sessions/{session_id}/runs/{run_id}` (path order matches existing `/audio` subresource style).

**Behavior**:

- 204 No Content on success.
- 404 `{"detail": "session not found"}` when `session_id` does not exist.
- 404 `{"detail": "run not found"}` when the session exists but the run id is unknown OR the run exists but belongs to a different session.
- Idempotent: a second DELETE on the same id returns 404 (run is gone), not 204.

**Verification target**: `tests/test_sessions_api.py` cases: happy path 204; session-missing 404; run-missing 404; run-belongs-to-other-session 404; idempotency check; verifies the row is gone via direct DB query.

### 6. Repo function (`app/services/persistence/sessions_repo.py`)

**Signature**:

```python
def delete_action_run(db: Session, session_id: str, run_id: int) -> bool:
    """Return True when a row was deleted, False when nothing matched."""
```

**Behavior**: single `DELETE FROM action_runs WHERE id = :rid AND session_id = :sid`. Returns `True` iff rowcount == 1. Caller in `app/api/sessions.py` translates the boolean into 204 vs 404.

**Verification target**: `tests/test_persistence_models.py` cases: happy path delete + check absent; wrong-session attempt returns False + row untouched; nonexistent id returns False.

### 7. main.ts wiring (`frontend/src/main.ts`)

**Behavior**:

- On boot: register `onRouteChange` handler that switches between recording shell and `HistoryView`.
- Existing "Show history" sidebar entry becomes a button that calls `navigateToHistory()`.
- Provide `runActionAgain` to the view: an async function that builds the action prompt from the template + transcript (reuse the same template-substitution logic the actions-bar uses), POSTs to `/ask`, then POSTs the answer to `/v1/sessions/<id>/runs` via `store.appendRun`.

### 8. Style + i18n

- `frontend/src/style.css`: new `.history-view`, `.history-rail`, `.history-detail`, `.history-run` rules. Mobile breakpoint at 768 px collapses to single-pane.
- `frontend/src/i18n/strings.ts`: en + zh-TW entries — `history.searchPlaceholder`, `history.empty`, `history.selectPrompt`, `history.addActionRun`, `history.deleteRunConfirm`, `history.deleteRunButton`, `history.runTimestamp`, `history.backToShell`, `history.sessionNotFound`.

### Scope boundaries

**In scope**:

- New hash routing module + History view component + DELETE endpoint + repo function.
- Existing `HistoryStore` gains `deleteRun`; existing `appendRun` is reused as-is.
- Existing `history-panel.ts` becomes the master-detail container OR is split into `history-view.ts` + a thin shim (implementer chooses).
- Style + i18n updates for the new UI strings.
- Test coverage matching ≥80% project rule for all new code paths.

**Out of scope**:

- Real client-side router or framework adoption.
- Server-side WS persistence.
- Server-side full-text search.
- Multi-tenant auth on `/v1/sessions/*`.
- New audio storage paths (the existing `/audio` endpoint is reused unchanged).
- Changes to `/listen`, `/transcribe`, or any non-history endpoint.

## Risks / Trade-offs

- **Hash-routing back-button surprise** → Mitigation: the route handler is the single source of truth, so back/forward correctly toggles shell ↔ History view; document this in the in-code comment for the routing module.
- **Mobile detail-panel discoverability** → Mitigation: when collapsed, a sticky "← Back" button maps to `navigateToHistory()` (clearing the session id) to return to the rail.
- **Concurrent re-runs racing on the same session** → Mitigation: the "+ AI Action" button disables itself while a re-run is in flight; on completion it re-enables. This matches the existing actions-bar single-flight pattern.
- **DELETE endpoint authorization (today: none)** → Mitigation: single-tenant assumption is unchanged; the composite-path form is forward-compat with future auth without API breakage.
- **Action picker reuse coupling** → Mitigation: if the actions-bar picker is hard to extract, build a thin reusable component in `frontend/src/ui/action-picker.ts` consumed by both surfaces; the actions-bar refactor is scope-contained and reversible.

## Migration Plan

No data migration. All existing `sessions` and `action_runs` rows render unchanged because the new view consumes the existing schema. The DELETE endpoint adds new behavior but does not require a DB migration.

Rollout order:

1. Backend DELETE endpoint + repo function (independent, can ship alone).
2. Frontend hash routing + History view (consumes the new endpoint at delete time but degrades gracefully if the DELETE returns 404).
3. Wire main.ts to switch on route change; remove the old sidebar mount.

Each step is independently verifiable; if step 3 surfaces an integration issue, steps 1-2 stay valuable and shippable.
