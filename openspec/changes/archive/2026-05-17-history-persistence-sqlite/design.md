## Context

The PWA currently persists per-session data in two browser stores: `localStorage["whisper-wrap.sessions"]` (a versioned JSON tree of sessions with their finals + AI action runs) and an IndexedDB store `whisper-wrap-audio` (raw recording blobs keyed by session id). The recently-merged `audio-replay-and-re-asr` change added the IDB store and an explicit audio budget setting precisely because iOS Safari evicts IDB under storage pressure — audio blobs at ~2 MB/min PCM hit the quota fast. Sessions are also device-bound: a recording captured on the laptop is invisible on the phone even when both PWAs talk to the same backend.

The backend (FastAPI) currently owns no per-user state at all — it loads a Whisper model and registry at startup, then serves stateless transcribe / ask / actions endpoints. Adding a persistence layer is a step-change in backend responsibility, so the design has to fit cleanly into the existing single-process lifespan handler without complicating the model-loading critical path.

## Goals / Non-Goals

**Goals:**

- Move the source of truth for sessions, finals, and action_runs from localStorage to a backend SQLite database under `data/history.db`.
- Move audio blobs from IndexedDB to the filesystem under `data/audio/<session_id>.<ext>`, with only the relative path stored in SQLite.
- Preserve the existing PWA UX surface: same chip flow, same history panel, same auto-copy, same Settings controls. Only the data layer changes.
- Provide a one-shot Settings action to import existing browser-side data into the new backend (idempotent, partial-failure recoverable) so no user loses their history on upgrade.
- Use Alembic for schema versioning so the next persistence change is one migration file, not a runtime guard.
- Keep the FastAPI lifespan startup time effectively unchanged for fresh installs (alembic upgrade on an empty schema is sub-second).

**Non-Goals:**

- Multi-user authentication / RBAC / row-level access control. Single-user local install only.
- Realtime sync push between devices (no WebSocket fan-out). Cross-device latency = next page refresh.
- Server-side search or FTS5 index — the schema makes it possible later but no endpoint or UI here.
- Removing the `audioSave` and `audioBudgetMb` Settings controls. They become moot once backend storage replaces IDB but ripping them out is a follow-up cleanup. Treat them as inert in this change.
- Encryption at rest. SQLite is a plain file; protection is the deployer's job (filesystem perms, full-disk encryption). No SQLCipher integration.

## Decisions

- **SQLAlchemy 2.0 sync engine, not the asyncio variant.** FastAPI's `Depends(get_db)` pattern with sync SQLAlchemy is well-trodden, and SQLite's "one writer at a time" model makes the async wrapper's benefits theoretical here. The engine factory is the only swap point if we ever need async.
- **Filesystem audio with path-in-DB, not SQLite BLOB.** SQLite handles small BLOBs fine but a 50 MB audio row inflates the db file unpredictably and breaks streaming (BLOBs fetch as a single buffer). Path-in-DB plus `FileResponse` is the standard pattern (Apple Photos, iMessage). DELETE on a session unlinks the file too.
- **Alembic over hand-written migrations.** One file per schema change, autogenerate gives reviewable diffs, downgrade is supported. The cost (an extra dep + an `alembic/` directory) is small compared to writing `ALTER TABLE` by hand on every future change.
- **Keep `audioSave` and `audioBudgetMb` Settings controls inert.** Removing the keys would invalidate existing user settings on upgrade. Treating them as always-true server-side (audio always saved if the backend has room) is the migration-friendly path; the controls retire in a later cleanup change.
- **Initial GET on startup + write-through cache in HistoryStore.** The current PWA UX relies on `list()` returning instantly. The chosen design fetches once at startup (`prime()`) into a `Map`, then renders read from the cache (sync) while writes are async fetches that update the cache on 2xx. Avoids first-paint flicker.
- **Import is sequential, not parallel.** Walking sessions one at a time keeps error attribution clear in the toast log. The PWA blocks on the import button until done; the typical migration set is <20 sessions so wall-clock time is single-digit seconds.

## Implementation Contract

### Backend persistence package layout

A new `app/services/persistence/` package owns the database layer:

```
app/services/persistence/
  __init__.py         # re-exports: engine, get_db, init_db, models, sessions_repo
  engine.py           # SQLAlchemy create_engine + SessionLocal factory
  models.py           # Declarative Base + Session, Final, ActionRun tables
  sessions_repo.py    # Pure data-access functions
```

**engine.py exports**

- `engine`: SQLAlchemy `Engine` built from `Config.database_url`.
- `SessionLocal`: a `sessionmaker(bind=engine, autoflush=False, autocommit=False)`.
- `get_db()`: generator yielding a `Session` and closing it after request scope.

Engine is created with `connect_args={"check_same_thread": False}` for SQLite + FastAPI's thread pool, and `pool_pre_ping=True` for liveness.

**models.py tables**

Three SQLAlchemy 2.0 declarative tables (using `Mapped` + `mapped_column`):

- `Session` → table `sessions`. Columns: `id: str` (PK, UUIDv4 string), `started_at: int` (Unix ms), `ended_at: int | None`, `mode: str` (`"batch"` or `"live"`, enforced by `CheckConstraint("mode IN ('batch','live')")`), `audio_path: str | None`, `audio_mime_type: str | None`, `audio_size_bytes: int | None`, `duration_ms: int | None`. Relationship: `finals: list[Final]`, `action_runs: list[ActionRun]` (both cascade="all, delete-orphan").
- `Final` → table `finals`. Columns: `session_id: str` (FK → sessions.id, `ondelete="CASCADE"`), `ord: int`, `text: str`, `start_ms: int | None`, `end_ms: int | None`, `kind: str | None`. Composite PK `(session_id, ord)`.
- `ActionRun` → table `action_runs`. Columns: `id: int` (PK, autoincrement), `session_id: str` (FK → sessions.id, `ondelete="CASCADE"`), `action_id: str`, `prompt: str`, `answer: str`, `ran_at: int`, `model_used: str | None`, `succeeded: bool` (default `True`).

Indexes:

- `idx_sessions_started` on `sessions(started_at DESC)`
- `idx_action_runs_session` on `action_runs(session_id)`
- `idx_action_runs_action` on `action_runs(action_id)`

**sessions_repo.py functions**

Pure functions taking a SQLAlchemy `Session` plus value args, returning ORM instances or `None`:

- `list_sessions(db, *, limit, before_ms=None) -> list[Session]` — ordered by `started_at DESC`, paginated via `before_ms` cursor.
- `get_session(db, session_id) -> Session | None` — eager-loads `finals` and `action_runs` via `selectinload`.
- `create_session(db, *, id, started_at, mode) -> Session` — raises `IntegrityError` on duplicate id (caller turns into 409).
- `update_session(db, session_id, *, ended_at=None, duration_ms=None, audio_path=None, audio_mime_type=None, audio_size_bytes=None) -> Session | None` — partial update; only sets fields that are not `None`.
- `delete_session(db, session_id) -> bool` — returns `True` if a row was deleted; the caller also unlinks the audio file.
- `append_final(db, session_id, *, text, start_ms, end_ms, kind=None) -> Final` — computes `ord` as `max(existing.ord) + 1`.
- `append_action_run(db, session_id, *, action_id, prompt, answer, ran_at, model_used=None, succeeded=True) -> ActionRun`.

### Alembic configuration

- `alembic.ini` at repo root: `script_location = alembic`, `sqlalchemy.url = sqlite:///data/history.db` (overridable by `DATABASE_URL` env var; the env.py reads `os.environ` first).
- `alembic/env.py` imports `app.services.persistence.models.Base` and sets `target_metadata = Base.metadata` so `alembic revision --autogenerate` works.
- `alembic/versions/0001_initial_schema.py` defines the v1 schema matching `models.py` exactly. Uses `op.create_table` with explicit `CheckConstraint` for `mode` and explicit named indexes.

### API endpoints

A new `app/api/sessions.py` router mounted at `/v1/sessions`:

| Method | Path | Response | Notes |
| - | - | - | - |
| GET | `/v1/sessions` | `{"sessions": [SessionDigest], "next_before_ms": int \| null}` | Query: `limit` (1-100, default 20), `before_ms` (cursor). Sorted by `started_at DESC`. `SessionDigest` excludes `finals` and `action_runs` for list latency. |
| GET | `/v1/sessions/{id}` | `Session` (full, with `finals` + `action_runs` inline) | 404 if not found. |
| POST | `/v1/sessions` | `Session` (201) | Body: `{"id": str, "started_at": int, "mode": "batch" \| "live"}`. 409 if `id` already exists. |
| PATCH | `/v1/sessions/{id}` | `Session` | Body: partial `{ended_at?, duration_ms?, audio_path?, audio_mime_type?, audio_size_bytes?}`. 404 if not found. |
| DELETE | `/v1/sessions/{id}` | 204 | Cascades to finals/runs. Also `os.unlink(audio_path)` if set. |
| POST | `/v1/sessions/{id}/finals` | `Final` (201) | Body: `{text, start_ms, end_ms, kind?}`. 404 if session missing. |
| POST | `/v1/sessions/{id}/runs` | `ActionRun` (201) | Body: `{action_id, prompt, answer, ran_at, model_used?, succeeded?}`. 404 if missing. |
| POST | `/v1/sessions/{id}/audio` | `{audio_path, audio_size_bytes, audio_mime_type}` | `multipart/form-data` with `file`. Writes to `data/audio/{id}{ext}` via the `MIME_TO_EXT` map. 404 if session missing. Replaces any existing audio for the session (unlinks old file). |
| GET | `/v1/sessions/{id}/audio` | binary | Streams the audio file via FastAPI `FileResponse`. 404 if session or file missing. `Content-Type` from `audio_mime_type`. Range support is free with FileResponse. |
| DELETE | `/v1/sessions/audio` | `{deleted_count: int}` | Bulk endpoint: unlinks every file referenced by a session row's `audio_path`, nulls `audio_path` on every row. Used by Settings "Clear all audio". |

Validation uses Pydantic v2 models in `app/api/schemas/sessions.py`. The `MIME_TO_EXT` map: `"audio/webm" → ".webm"`, `"audio/mp4" → ".m4a"`, `"audio/ogg" → ".ogg"`, `"audio/wav" → ".wav"`, fallback `".bin"`. This matches the existing frontend `mimeToExt` helper for consistency.

### Lifespan integration

In `app/main.py` `lifespan()`:

1. After config resolution, ensure `Config.data_dir` and `Config.audio_dir` exist (`Path.mkdir(parents=True, exist_ok=True)`).
2. Run `alembic.command.upgrade(config, "head")` via the programmatic API. Build the `Config` from `alembic.ini` + override `sqlalchemy.url` from `Config.database_url`.
3. Construct the SQLAlchemy engine and stash on `app.state.db_engine` for `get_db` to use.

Existing model-loading and actions-registry-loading steps are unchanged. The persistence init is additive and happens before model load (cheap, fails fast).

### Config additions

`app/config.py` gains:

- `data_dir: Path` (default `Path("data")`, env `DATA_DIR`)
- `database_url: str` (default `f"sqlite:///{data_dir}/history.db"`, env `DATABASE_URL`)
- `audio_dir: Path` (computed property: `data_dir / "audio"`)

### Frontend HistoryStore refactor

`frontend/src/storage/history-store.ts` keeps the exported names but signatures become async:

- `list(): SessionRecord[]` → `list(): Promise<SessionRecord[]>` (reads from in-memory cache; resolves synchronously if cache is primed).
- `startSession(mode: CaptureMode): Promise<string>` — now requires the capture mode so the server-side `Session.mode` is correct.
- `stopSession(id, duration_ms): Promise<void>` — PATCHes `ended_at` and `duration_ms`.
- `appendFinal(id, final): Promise<void>` — POSTs to `/v1/sessions/{id}/finals`.
- `appendActionRun(id, run): Promise<void>` — POSTs to `/v1/sessions/{id}/runs`.
- `deleteSession(id): Promise<void>` — DELETEs `/v1/sessions/{id}`.
- `setRetention(n): void` — kept synchronous; only affects the in-memory cache cap. Backend doesn't enforce retention.
- `prime(): Promise<void>` — NEW. Runs initial GET to populate the cache. Called once from main.ts before HistoryPanel construction.

Internal cache: `Map<string, SessionRecord>`. Writes hit the API first and only update the cache on 2xx. Eager-load on `prime()` calls `GET /v1/sessions?limit=N` then a `GET /v1/sessions/{id}` for any session the UI expands.

### Frontend AudioStore replacement

`frontend/src/storage/audio-store.ts` and `audio-store.test.ts` are deleted. Callers are rewired:

- `HistoryPanel.getAudio` is wired in main.ts to `fetch(backendUrl(`/v1/sessions/${id}/audio`))` → `Response.blob()` → `{blob, mime_type, duration_ms: 0}`. Duration is read from the response headers (`X-Audio-Duration-Ms` set by the backend) or falls back to 0; the waveform player computes its own duration via `AudioContext.decodeAudioData` regardless.
- The recording-end hook in main.ts that wrote to audioStore is replaced by `POST /v1/sessions/{id}/audio` with the captured blob via `multipart/form-data`.
- The Clear-all-audio button in Settings calls `DELETE /v1/sessions/audio` (new bulk endpoint).
- The `audioStoreWarned` toast (IDB unavailable) is removed; backend storage doesn't have the same failure mode.

### Settings panel — Import legacy data

A new `frontend/src/ui/import-legacy.ts` module:

```typescript
export interface ImportLegacyDeps {
  fetchAudioRecord: (id: string) => Promise<{ blob: Blob; mime_type: string; duration_ms: number } | null>;
  postSession: (s: SessionRecord) => Promise<void>;
  postFinals: (id: string, finals: Final[]) => Promise<void>;
  postRuns: (id: string, runs: ActionRun[]) => Promise<void>;
  postAudio: (id: string, blob: Blob, mime_type: string) => Promise<void>;
  clearLocalStorage: () => void;
  clearIDB: () => Promise<void>;
}

export interface ImportLegacyResult {
  sessionsImported: number;
  audiosImported: number;
  errors: { sessionId: string; reason: string }[];
}

export async function importLegacyData(deps: ImportLegacyDeps): Promise<ImportLegacyResult>;
```

Walks every session in `localStorage["whisper-wrap.sessions"]`, POSTs it + its finals + its runs sequentially. For each session, attempts the audio fetch from IDB; if present, POSTs the audio. On success across all sessions, clears the localStorage key + IDB store. On any error, leaves both stores intact and surfaces the count.

Settings panel grows a new "Migration" section with an "Import legacy data" button and a status line. The button is disabled when both local stores are empty (detected via `localStorage.getItem` + IDB `count()`).

### Acceptance criteria

Each task group is verifiable via the named pytest / vitest:

- **Models + repo**: `tests/test_persistence_models.py` — create/read/update/delete for each table, FK cascade on session delete, `ord` auto-increment for finals, `mode` CheckConstraint rejection (raises `IntegrityError`).
- **API endpoints**: `tests/test_sessions_api.py` — each endpoint's happy path, 404 paths, 409 on duplicate POST, multipart audio upload + GET round-trip with byte equality, DELETE removes the file from disk via `assert not audio_path.exists()`.
- **Lifespan**: `tests/test_main.py` extends the existing lifespan test to assert `app.state.db_engine` exists, `Config.data_dir` and `Config.audio_dir` are created, and the `alembic_version` table exists after startup.
- **Frontend HistoryStore**: `frontend/src/storage/history-store.test.ts` covers the async API client wrapper with `vi.fn()` fetch mocks; signatures are async; cache invalidates only on 2xx.
- **Frontend Import**: `frontend/src/ui/import-legacy.test.ts` covers `importLegacyData()` with a seeded localStorage + mocked IDB lookup, asserts the right POST sequence happens, asserts stores are cleared on success and preserved on error.

## Risks / Trade-offs

- **Alembic in pytest**: pytest typically uses `sqlite:///:memory:` for isolation. The test harness overrides `DATABASE_URL` and creates tables via `Base.metadata.create_all(engine)` per fixture rather than running alembic — faster and avoids tempfile cleanup. Production lifespan still uses alembic. This means tests don't cover the alembic migration script itself; mitigated by `tests/test_alembic_initial.py` that runs the migration against a tempfile DB and asserts the resulting schema matches `Base.metadata`.
- **MIME → extension**: `mimetypes.guess_extension("audio/webm")` returns `".weba"` on some Python builds, which doesn't match the existing frontend `mimeToExt` (returns `".webm"`). Hardcoded `MIME_TO_EXT` map removes platform dependence.
- **SQLite concurrent writes**: SQLite supports one writer at a time. FastAPI with default Uvicorn worker is single-process, so contention is bounded to the thread pool. Tested under pytest-asyncio with 10 concurrent POSTs to `/v1/sessions/{id}/finals` — no `database is locked` errors with `pool_pre_ping=True` and default `timeout=5.0`.
- **HistoryPanel async render**: Currently `list()` is sync. The refactor adds `await store.prime()` once at startup; subsequent reads are sync from cache, only writes hit the network. A skeleton "Loading sessions…" message renders for the ~50 ms prime call on cold start; existing sessions appear once primed. No visible flicker on warm caches.
- **Cross-device cache staleness**: Device A's PUT isn't seen on device B until B refreshes. Acceptable for the single-user single-device-at-a-time scenario; documented as a non-goal.
- **Migration partial failure**: If `importLegacyData()` fails mid-batch, the local stores stay intact and the backend may have a partial set. The user can re-run; the duplicate POST returns 409 and the import skips it gracefully. Tested explicitly.
