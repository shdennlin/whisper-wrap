## ADDED Requirements

### Requirement: Single action_run deletion endpoint

The backend SHALL expose `DELETE /v1/sessions/{session_id}/runs/{run_id}` that removes one row from the `action_runs` table. The endpoint SHALL be idempotent at the URL level: deleting an already-absent row SHALL return 404, not 204.

The persistence repo SHALL provide `delete_action_run(db, session_id, run_id) -> bool` that issues a single `DELETE FROM action_runs WHERE id = :run_id AND session_id = :session_id` and returns `True` iff the row count is 1. The API layer SHALL map `True` to 204 and `False` to 404. The session-id constraint in the WHERE clause SHALL be enforced — a run id whose row exists under a different session SHALL NOT be deleted and the call SHALL return 404.

The endpoint SHALL NOT touch the session row, other `action_runs` rows, or any audio file. It SHALL return 404 `{"detail": "session not found"}` when the session id is unknown and 404 `{"detail": "run not found"}` when the run id is unknown for the given session.

#### Scenario: Deleting an existing run returns 204 and removes the row

- **GIVEN** a session `S` with three `action_runs` having ids 11, 12, 13
- **WHEN** the PWA sends `DELETE /v1/sessions/S/runs/12`
- **THEN** the response SHALL be 204 with empty body
- **AND** `GET /v1/sessions/S` SHALL return a session payload with `action_runs` of length 2 containing ids 11 and 13 only

#### Scenario: Deleting an absent run returns 404

- **GIVEN** session `S` with no `action_runs`
- **WHEN** the PWA sends `DELETE /v1/sessions/S/runs/999`
- **THEN** the response SHALL be 404 with body `{"detail": "run not found"}`

#### Scenario: Deleting a run from a wrong session id returns 404

- **GIVEN** session `A` owns run id 50, and session `B` exists with no runs
- **WHEN** the PWA sends `DELETE /v1/sessions/B/runs/50`
- **THEN** the response SHALL be 404 with body `{"detail": "run not found"}`
- **AND** `GET /v1/sessions/A` SHALL still include run id 50 in `action_runs`

#### Scenario: Deleting when the session id is unknown returns 404

- **WHEN** the PWA sends `DELETE /v1/sessions/<nonexistent>/runs/1`
- **THEN** the response SHALL be 404 with body `{"detail": "session not found"}`

#### Scenario: A second delete after success returns 404 (idempotency)

- **GIVEN** the PWA has just issued `DELETE /v1/sessions/S/runs/7` and received 204
- **WHEN** the PWA repeats `DELETE /v1/sessions/S/runs/7`
- **THEN** the response SHALL be 404 with body `{"detail": "run not found"}`

### Requirement: HistoryStore exposes deleteRun for single-run removal

The PWA's `HistoryStore` SHALL expose `deleteRun(session_id, run_id): Promise<void>` that issues `DELETE /v1/sessions/<session_id>/runs/<run_id>`. On 204 the store SHALL remove the run from the cached session's `action_runs` array. On a non-204 response the store SHALL reject the promise with a `HistoryApiError` carrying the HTTP status; the cache SHALL be unchanged.

The store SHALL fire the existing `onError` callback (set in `HistoryStore` construction) on non-204 responses so the existing toast surface displays the error consistently with other write failures.

#### Scenario: Successful delete prunes the cache

- **GIVEN** the in-memory cache holds session `S` with `action_runs` of ids [1, 2, 3]
- **WHEN** the PWA calls `await store.deleteRun("S", 2)` and the API returns 204
- **THEN** the promise SHALL resolve
- **AND** `store.list()` for `S` SHALL return `action_runs` with ids [1, 3]

#### Scenario: Non-204 leaves the cache untouched

- **GIVEN** the in-memory cache holds session `S` with `action_runs` of ids [1, 2, 3]
- **WHEN** the PWA calls `await store.deleteRun("S", 2)` and the API returns 404
- **THEN** the promise SHALL reject with a `HistoryApiError` whose `status` is 404
- **AND** the `onError` callback SHALL be invoked once
- **AND** `store.list()` for `S` SHALL still return `action_runs` with ids [1, 2, 3]
