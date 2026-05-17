## ADDED Requirements

### Requirement: SQLite-backed session persistence

The backend SHALL persist session metadata, transcript finals, and AI action runs in a SQLite database under the configured `database_url`. Schema is managed by Alembic and migrated to head on FastAPI lifespan startup before the model loader runs.

#### Scenario: Fresh install creates schema on startup

- **WHEN** the FastAPI app starts with no existing database file
- **THEN** the `data_dir` and `audio_dir` directories are created with `parents=True, exist_ok=True`
- **AND** Alembic runs `upgrade head` against the configured `database_url`
- **AND** the SQLAlchemy engine is constructed and stored on `app.state.db_engine`
- **AND** the lifespan continues to model loading

#### Scenario: Existing install at older revision migrates forward

- **GIVEN** a database file exists at `database_url` with `alembic_version` table pointing to revision N
- **WHEN** the FastAPI app starts with migration scripts present up to revision N+1
- **THEN** Alembic upgrades the database to revision N+1
- **AND** existing rows are preserved (cascade rules and indexes update without data loss)

##### Example: Schema columns at v1 baseline

| Table | Columns |
| - | - |
| `sessions` | `id PK, started_at, ended_at, mode CHECK IN ('batch','live'), audio_path, audio_mime_type, audio_size_bytes, duration_ms` |
| `finals` | `session_id FK CASCADE, ord, text, start_ms, end_ms, kind` — composite PK `(session_id, ord)` |
| `action_runs` | `id PK AUTOINCREMENT, session_id FK CASCADE, action_id, prompt, answer, ran_at, model_used, succeeded` |

### Requirement: REST API for session lifecycle

The backend SHALL expose a `/v1/sessions` REST API covering creation, list, get, partial update, and delete of sessions, plus append-only writes for finals and action_runs.

#### Scenario: Client creates a session at recording start

- **WHEN** the PWA sends `POST /v1/sessions` with body `{"id": "<uuid>", "started_at": <ms>, "mode": "batch"}`
- **THEN** the server returns 201 with the full Session payload (empty `finals`, empty `action_runs`)
- **AND** subsequent `POST /v1/sessions` with the same id returns 409 Conflict

#### Scenario: Client lists sessions with pagination

- **WHEN** the PWA sends `GET /v1/sessions?limit=20`
- **THEN** the server returns up to 20 session digests sorted by `started_at DESC`
- **AND** each digest excludes `finals` and `action_runs` for list latency
- **AND** the response includes `next_before_ms` for pagination cursor (or `null` when fewer than `limit` results returned)

#### Scenario: Client appends finals incrementally during Live mode

- **WHEN** the PWA sends `POST /v1/sessions/{id}/finals` with `{"text": "...", "start_ms": 1000, "end_ms": 2500}` repeatedly during a Live session
- **THEN** each call returns 201 with the new `Final` row including its auto-assigned `ord` (monotonic per session)
- **AND** `GET /v1/sessions/{id}` returns the finals array in `ord` ascending order

#### Scenario: Session deletion cascades to finals, runs, and audio file

- **GIVEN** a session with 3 finals, 2 action runs, and an audio file at `data/audio/<id>.webm`
- **WHEN** the PWA sends `DELETE /v1/sessions/{id}`
- **THEN** the server returns 204
- **AND** rows in `finals` and `action_runs` for that session are deleted via FK cascade
- **AND** the audio file at `data/audio/<id>.webm` no longer exists on disk

#### Scenario: Get on missing session returns 404

- **WHEN** the PWA sends `GET /v1/sessions/<nonexistent-id>`
- **THEN** the server returns 404 with body `{"detail": "session not found"}`

### Requirement: Audio blob storage on filesystem

The backend SHALL store raw audio recordings on the filesystem under `audio_dir/{session_id}{ext}` and reference them via the `sessions.audio_path` column. Audio is NEVER stored as a SQLite BLOB.

#### Scenario: Audio upload writes file and updates session row

- **GIVEN** a session exists with `id="abc-123"`
- **WHEN** the PWA sends `POST /v1/sessions/abc-123/audio` with `multipart/form-data` containing `file` of mime type `audio/webm`
- **THEN** the server writes the bytes to `data/audio/abc-123.webm` (extension derived from the `MIME_TO_EXT` map)
- **AND** the server updates the session row with `audio_path="data/audio/abc-123.webm"`, `audio_mime_type="audio/webm"`, and `audio_size_bytes=<actual byte length>`
- **AND** the server returns 200 with `{"audio_path", "audio_size_bytes", "audio_mime_type"}`

##### Example: MIME → extension mapping

| `mime_type` | Extension | Notes |
| - | - | - |
| `audio/webm` | `.webm` | Most common batch upload format |
| `audio/mp4` | `.m4a` | Safari batch recording |
| `audio/ogg` | `.ogg` | Firefox / Linux capture |
| `audio/wav` | `.wav` | Live mode silero VAD outputs |
| `audio/anything-else` | `.bin` | Fallback (logged at WARN level) |

#### Scenario: Audio stream supports HTTP Range requests

- **GIVEN** a session with an audio file at `data/audio/abc.webm` of 1 MB
- **WHEN** the PWA sends `GET /v1/sessions/abc/audio` with header `Range: bytes=0-1023`
- **THEN** the server returns 206 Partial Content with the first 1024 bytes
- **AND** the response includes `Content-Range: bytes 0-1023/1048576`

#### Scenario: Audio replacement unlinks the old file

- **GIVEN** a session has `audio_path="data/audio/abc.webm"` already populated
- **WHEN** the PWA sends a second `POST /v1/sessions/abc/audio` with a different blob
- **THEN** the old file at `data/audio/abc.webm` is unlinked from disk before the new file is written
- **AND** the new `audio_size_bytes` reflects the new blob's length

#### Scenario: Bulk audio clear removes every file

- **WHEN** the PWA sends `DELETE /v1/sessions/audio`
- **THEN** every file referenced by a session row's `audio_path` is unlinked from disk
- **AND** every session row's `audio_path`, `audio_mime_type`, and `audio_size_bytes` columns are set to NULL
- **AND** the response is `{"deleted_count": <number of files unlinked>}`

### Requirement: Frontend HistoryStore presents the API as the same interface as before

The PWA's `HistoryStore` SHALL preserve the existing public method names (`list`, `startSession`, `stopSession`, `appendFinal`, `appendActionRun`, `deleteSession`, `setRetention`) but the method bodies SHALL become async HTTP calls against the new endpoints. The interface change is async return types, not method renames.

#### Scenario: Initial render primes the cache from a single GET

- **WHEN** the PWA loads
- **THEN** `HistoryStore.prime()` issues exactly one `GET /v1/sessions?limit=<retention>` call
- **AND** the response populates an in-memory `Map<string, SessionRecord>` cache
- **AND** subsequent `HistoryStore.list()` calls return synchronously from the cache

#### Scenario: Write methods go to the API first, cache updates only on success

- **WHEN** the PWA calls `await store.appendFinal(sessionId, finalRecord)`
- **THEN** the store issues `POST /v1/sessions/{id}/finals` with the body
- **AND** if the response is 2xx, the in-memory cache adds the new final to the session
- **AND** if the response is non-2xx, the cache is unchanged and the promise rejects with the error

##### Example: Public surface translation

| Method | Old return | New return | Notes |
| - | - | - | - |
| `list()` | `SessionRecord[]` | `Promise<SessionRecord[]>` | Resolves synchronously when cache primed |
| `startSession(mode)` | `string` (sync) | `Promise<string>` | New `mode` parameter required so server `Session.mode` is correct |
| `appendFinal(id, f)` | `void` | `Promise<void>` | Network write + cache update |
| `appendActionRun(id, r)` | `void` | `Promise<void>` | Same as above |
| `stopSession(id, dur)` | `void` | `Promise<void>` | PATCHes `ended_at` + `duration_ms` |
| `deleteSession(id)` | `void` | `Promise<void>` | DELETEs the session resource |
| `setRetention(n)` | `void` | `void` (unchanged) | Only affects in-memory cap; backend doesn't enforce |
| `prime()` | (new) | `Promise<void>` | NEW. Initial fetch. main.ts awaits once at startup. |

### Requirement: One-shot legacy data import from browser storage to backend

The Settings panel SHALL provide an explicit "Import legacy data" action that walks the existing browser-side stores (`localStorage["whisper-wrap.sessions"]` and IndexedDB `whisper-wrap-audio`), POSTs every session + finals + runs + audio blob to the new backend, then clears the local stores on success.

#### Scenario: Successful import clears local stores

- **GIVEN** `localStorage["whisper-wrap.sessions"]` contains 5 sessions
- **AND** IndexedDB `whisper-wrap-audio` contains 3 audio blobs (for sessions A, B, C)
- **WHEN** the user clicks "Import legacy data"
- **THEN** the panel sequentially POSTs each session + its finals + its runs to the backend
- **AND** for the 3 sessions that have audio blobs, the panel uploads the audio
- **AND** on success across all 5 sessions, `localStorage["whisper-wrap.sessions"]` is removed and IndexedDB store is cleared
- **AND** the panel surfaces `{"sessionsImported": 5, "audiosImported": 3, "errors": []}`

#### Scenario: Partial failure preserves local stores

- **GIVEN** `localStorage["whisper-wrap.sessions"]` contains 5 sessions and the backend is reachable
- **WHEN** the user clicks "Import legacy data" and session #3 fails to POST (e.g., 500 from the backend mid-batch)
- **THEN** the panel continues importing sessions 4 and 5
- **AND** `localStorage["whisper-wrap.sessions"]` is NOT removed (the local source is preserved for retry)
- **AND** IndexedDB store is NOT cleared
- **AND** the result surfaces `{"errors": [{"sessionId": "<session-3-id>", "reason": "..."}]}`

#### Scenario: Re-importing after a successful import is a no-op

- **GIVEN** the local stores are empty (previous import succeeded)
- **WHEN** the user clicks "Import legacy data" again
- **THEN** the button is disabled in the UI (detected via `localStorage.getItem` and IDB `count()`)
- **AND** if forced via DevTools, `importLegacyData()` returns `{"sessionsImported": 0, "audiosImported": 0, "errors": []}` without making any network requests

#### Scenario: Duplicate session ids handled gracefully

- **GIVEN** the backend already has a session with id `dup-1` from a prior partial import attempt
- **WHEN** `importLegacyData()` attempts to POST `dup-1` again
- **THEN** the backend returns 409 Conflict for the create
- **AND** the import treats 409 as "already imported, skip" — moves on to the session's finals + runs + audio, which are append-only
- **AND** the per-session import counts as successful (no error recorded)
