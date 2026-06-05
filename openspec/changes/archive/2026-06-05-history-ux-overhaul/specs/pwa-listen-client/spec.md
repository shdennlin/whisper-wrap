## REMOVED Requirements

### Requirement: History panel persists last 20 capture sessions to localStorage

**Reason**: Two superseding changes invalidate this requirement. (1) The `history-persistence` capability (archived as `history-persistence-sqlite`) moved persistence from `localStorage` to the SQLite-backed `/v1/sessions` API; `HistoryStore` is now an API client with an in-memory cache. (2) The new master-detail History view (ADDED below) replaces the sidebar panel rendering described here. The 20-session cap and ULID-style ids are now properties of the backend session lifecycle, not of this UI requirement.

**Migration**: All UI behavior is replaced by the new ADDED Requirement "History view renders as master-detail pseudo-route with re-runnable AI Actions". All persistence behavior is owned by the `history-persistence` spec's existing requirements ("SQLite-backed session persistence", "REST API for session lifecycle", "Frontend HistoryStore presents the API as the same interface as before"). No data migration is required because `HistoryStore`'s cache is rebuilt from the API on each load.

## ADDED Requirements

### Requirement: History view renders as master-detail pseudo-route with re-runnable AI Actions

The PWA SHALL render history as a master-detail view mounted on the hash route `#/history` (no selection) and `#/history/<session_id>` (with selection). The recording shell SHALL remain mounted at the empty hash. The History view SHALL claim the full viewport width (not the sidebar) and SHALL contain a left rail listing sessions and a right detail panel for the selected session.

The rail SHALL render sessions in reverse chronological order (newest first) and SHALL include a search box that filters the rail entries case-insensitively against each session's formatted `started_at` (`YYYY-MM-DD HH:MM`) and the concatenation of `finals[].text`. Search filtering SHALL be debounced to 120 ms on input and SHALL operate over the in-memory cache populated by `HistoryStore.prime()`. Each rail row SHALL display the session's date, duration, and word count.

The detail panel SHALL render the selected session's metadata (date, duration, word count), waveform audio player (when an audio file exists, behaviorally identical to the existing `WaveformPlayer`), full transcript (joined `finals[].text`), an action-runs list, and an "Add AI Action" control. The action-runs list SHALL render every row of `action_runs` for the session, sorted by `ran_at DESC`, each row showing the resolved action label, the timestamp, the answer body, and a per-run Delete button.

The "Add AI Action" control SHALL open the existing action picker (the same templates loaded from `/actions`); on confirm the PWA SHALL POST the templated prompt to `/ask` as text input (no audio body), and on the answer SHALL POST `{"action_id", "prompt", "answer", "ran_at"}` to `POST /v1/sessions/<id>/runs`. While a re-run is in flight, the "Add AI Action" control SHALL be disabled to prevent duplicate concurrent submissions for the same session. On success the runs list SHALL re-render to include the new row.

Each action-run row's Delete button SHALL open a confirm dialog and on confirm SHALL call `HistoryStore.deleteRun(session_id, run_id)`. On 204 the run row SHALL be removed from the panel without a full page reload.

When the viewport width is at or below 768 px the rail and detail SHALL occupy the full width and SHALL toggle: when no `session_id` is present the rail SHALL be visible; when a `session_id` is present the detail SHALL be visible with a "Back" affordance that navigates to `#/history` (rail-only).

#### Scenario: Hash route mounts History view

- **GIVEN** the PWA is loaded with hash `""`
- **AND** the recording shell is mounted
- **WHEN** the user activates the Show-history control or `location.hash` becomes `#/history`
- **THEN** the recording shell is hidden and the History view is mounted with the rail populated and the detail panel showing an empty state

#### Scenario: Selecting a session updates the route

- **GIVEN** the History view is mounted at `#/history`
- **WHEN** the user clicks a session row in the rail
- **THEN** `location.hash` SHALL become `#/history/<session_id>` and the detail panel SHALL render that session's transcript and `action_runs`

#### Scenario: Search filters the rail

- **GIVEN** the rail contains 12 sessions with various transcript content
- **WHEN** the user types "meeting" into the search box
- **THEN** within 120 ms only sessions whose formatted date or `finals[].text` contains "meeting" (case-insensitive) SHALL remain visible in the rail
- **AND** clearing the search box SHALL restore all 12 sessions

#### Scenario: Re-running an Action against a past session appends a new run

- **GIVEN** the detail panel is rendered for session `S` with two existing `action_runs`
- **WHEN** the user clicks "Add AI Action", picks template `summarize`, and confirms
- **THEN** the PWA SHALL POST `{"text": "<templated prompt>"}` to `/ask`
- **AND** on the answer SHALL POST `{"action_id": "summarize", "prompt": "...", "answer": "...", "ran_at": <ms>}` to `POST /v1/sessions/S/runs`
- **AND** the detail panel SHALL render three runs sorted by `ran_at DESC`, the newest at the top

#### Scenario: Concurrent re-run guard

- **GIVEN** the detail panel is showing session `S` and the user clicks "Add AI Action" and confirms template `summarize`
- **WHEN** the user clicks "Add AI Action" again before the in-flight `/ask` resolves
- **THEN** the "Add AI Action" control SHALL be disabled and the second click SHALL NOT produce a second `/ask` POST

#### Scenario: Deleting one run leaves others intact

- **GIVEN** session `S` has three `action_runs` rendered in the detail panel
- **WHEN** the user clicks the Delete button on the middle row, confirms the dialog, and `DELETE /v1/sessions/S/runs/<run_id>` returns 204
- **THEN** that row SHALL be removed from the detail panel
- **AND** the remaining two rows SHALL still render in their original order
- **AND** `HistoryStore.list()` for session `S` SHALL return two `action_runs`

#### Scenario: Mobile collapse toggles between rail and detail

- **GIVEN** the viewport is 360 px wide and the user is at `#/history`
- **WHEN** the user clicks a session row
- **THEN** the rail SHALL hide, the detail SHALL fill the viewport, and a "Back" control SHALL be visible
- **WHEN** the user clicks "Back"
- **THEN** `location.hash` SHALL become `#/history` and the rail SHALL be visible while the detail SHALL be hidden
