## 1. Backend persistence package — SQLite-backed session persistence + backend persistence package layout

- [x] 1.1 Add `pyproject.toml` deps `sqlalchemy>=2.0` and `alembic>=1.13`; run `uv sync` and confirm both import in a python REPL (`python -c "import sqlalchemy, alembic"` exits 0). Covers the "SQLite-backed session persistence" requirement's dependency on SQLAlchemy 2.0.
- [x] 1.2 Extend `app/config.py` with `data_dir: Path = Path("data")` (env `DATA_DIR`), `database_url: str = "sqlite:///{data_dir}/history.db"` (env `DATABASE_URL`), and a computed `audio_dir: Path = data_dir / "audio"`. Implements the design's "Config additions" topic. Verify via `tests/test_config.py::test_persistence_defaults` that env override changes the resolved values.
- [x] 1.3 Create `app/services/persistence/engine.py` exposing `engine`, `SessionLocal`, and `get_db()` per the Implementation Contract (sync SQLAlchemy 2.0, `connect_args={"check_same_thread": False}`, `pool_pre_ping=True`). Verify by importing and `engine.connect()` succeeding against an in-memory URL in `tests/test_persistence_engine.py`.
- [x] 1.4 Create `app/services/persistence/models.py` with `Base`, `Session`, `Final`, `ActionRun` matching the design's column list, CheckConstraint on `Session.mode`, FK CASCADE on delete, composite PK on Final, named indexes. Verify by `Base.metadata.create_all(engine)` then introspecting that all three tables + named indexes exist (`tests/test_persistence_models.py::test_schema_shape`).
- [x] 1.5 Create `app/services/persistence/sessions_repo.py` with `list_sessions`, `get_session`, `create_session`, `update_session`, `delete_session`, `append_final`, `append_action_run` per Implementation Contract. Verify via `tests/test_persistence_models.py` covering happy path for each function plus FK cascade on `delete_session` and `IntegrityError` on duplicate session id.

## 2. Alembic migration scaffold — Alembic configuration

- [x] 2.1 [P] Create `alembic.ini` at repo root with `script_location = alembic` and `sqlalchemy.url` placeholder; `alembic/env.py` reads `os.environ["DATABASE_URL"]` first, falls back to `Config.database_url`. Implements the design's "Alembic configuration" topic. Verify by running `uv run alembic check` (exits 0 when no schema drift).
- [x] 2.2 [P] Write `alembic/versions/0001_initial_schema.py` creating the three tables + CheckConstraint + indexes via `op.create_table` / `op.create_index`. Verify by running `uv run alembic upgrade head` against a tempfile DB and asserting `sqlite_master` lists all expected tables in `tests/test_alembic_initial.py`.

## 3. Lifespan integration — SQLite-backed session persistence (startup wiring)

- [x] 3.1 In `app/main.py` `lifespan()`, before model load: ensure `Config.data_dir` and `Config.audio_dir` exist (`mkdir parents=True exist_ok=True`), then `alembic.command.upgrade(alembic_cfg, "head")`, then construct the engine and stash on `app.state.db_engine`. This realises the "SQLite-backed session persistence" requirement's startup contract. Verify `tests/test_main.py::test_lifespan_initializes_persistence` asserts the directories exist, `alembic_version` table is populated, and `app.state.db_engine` is non-None.

## 4. API endpoints — REST API for session lifecycle + Audio blob storage on filesystem

- [x] 4.1 [P] Create `app/api/schemas/sessions.py` with Pydantic v2 models for `SessionCreate`, `SessionPatch`, `SessionDigest`, `SessionFull`, `FinalIn`, `FinalOut`, `ActionRunIn`, `ActionRunOut`, `AudioMetaOut`. These power the REST API for session lifecycle. Verify by serialising/deserialising sample dicts in `tests/test_sessions_api.py::test_schemas_roundtrip`.
- [x] 4.2 [P] Create `app/api/sessions.py` router with `GET /v1/sessions`, `GET /v1/sessions/{id}`, `POST /v1/sessions`, `PATCH /v1/sessions/{id}`, `DELETE /v1/sessions/{id}` per the "REST API for session lifecycle" requirement. Use `Depends(get_db)`. Mount the router in `app/main.py`. Verify via `tests/test_sessions_api.py` happy-path and 404/409 cases for each.
- [x] 4.3 [P] Extend `app/api/sessions.py` with `POST /v1/sessions/{id}/finals` and `POST /v1/sessions/{id}/runs` endpoints + tests asserting the new rows appear in `GET /v1/sessions/{id}` body and `ord` is auto-monotonic for finals. Continues the "REST API for session lifecycle" requirement coverage.
- [x] 4.4 Implement `POST /v1/sessions/{id}/audio` (multipart upload) and `GET /v1/sessions/{id}/audio` (FileResponse with Range support) plus the `MIME_TO_EXT` map. Realises the "Audio blob storage on filesystem" requirement. Verify byte-equality round-trip in `tests/test_sessions_api.py::test_audio_upload_get_byte_equal` and Range request returns 206 in `test_audio_range_request`.
- [x] 4.5 Implement `DELETE /v1/sessions/audio` bulk endpoint that unlinks every file referenced by a session row's `audio_path` and nulls the path columns. Required by the "Audio blob storage on filesystem" requirement's bulk clear scenario. Verify in `tests/test_sessions_api.py::test_audio_bulk_clear_removes_files_and_nulls_columns`.
- [x] 4.6 Extend `DELETE /v1/sessions/{id}` to unlink `audio_path` from disk before returning 204. Verify `tests/test_sessions_api.py::test_delete_session_unlinks_audio_file` asserts `not audio_path.exists()` post-delete.

## 5. Frontend HistoryStore refactor — Frontend HistoryStore presents the API as the same interface as before

- [x] 5.1 Create `frontend/src/storage/history-api-client.ts` exposing thin `fetch`-based functions for each endpoint (`listSessions`, `getSession`, `createSession`, `patchSession`, `deleteSession`, `appendFinal`, `appendActionRun`, `uploadAudio`, `getAudio`, `bulkClearAudio`). Each function takes a `backendUrl: string` and the endpoint inputs, returns the typed response. Verify via `frontend/src/storage/history-api-client.test.ts` covering each function with `vi.fn()` fetch mocks asserting URL, method, body, and 2xx/4xx handling.
- [x] 5.2 Rewrite `frontend/src/storage/history-store.ts` to use `history-api-client.ts` internally. Public method names unchanged; signatures become `Promise`-returning per the design's "Public surface translation" table. Add a `prime(backendUrl)` method that fills an in-memory `Map` cache from `listSessions`. This delivers the "Frontend HistoryStore presents the API as the same interface as before" requirement. Verify via updated `frontend/src/storage/history-store.test.ts` asserting cache priming, write-through behaviour, and 2xx-only cache updates.
- [x] 5.3 Adapt `frontend/src/main.ts` to await the new async `HistoryStore` methods. Add a one-time `await store.prime(backendUrl)` before `new HistoryPanel(...)`. `actionsBar.onAnswer` becomes `async` so `await store.appendActionRun(...)` works without floating promises. Verify via manual smoke test (run dev server, start recording, stop, click chip, expand history card) plus that `bun run test` still passes.

## 6. Frontend AudioStore retirement — Frontend AudioStore replacement

- [x] 6.1 Delete `frontend/src/storage/audio-store.ts` and `frontend/src/storage/audio-store.test.ts` per the design's "Frontend AudioStore replacement" topic. Rewire main.ts:
  - `audioStore.put(...)` (recording end) → `apiClient.uploadAudio(sessionId, blob, mime_type)`.
  - `audioStore.get(id)` (HistoryPanel) → `apiClient.getAudio(id)` returning the backend blob.
  - `audioStore.clear()` (Settings) → `apiClient.bulkClearAudio()`.
  Remove the `audioStoreWarned` toast (no longer applicable). Verify by deleting the imports + grep'ing for `AudioStore` returns no hits, plus `make build-frontend` and full `bun run test` pass.

## 7. Frontend Settings — One-shot legacy data import from browser storage to backend (also the Settings panel — Import legacy data design topic)

- [x] 7.1 Create `frontend/src/ui/import-legacy.ts` with `importLegacyData(deps): Promise<ImportLegacyResult>` per the design's `ImportLegacyDeps` interface. Walk sessions sequentially; clear localStorage + IDB only when `errors.length === 0`. Handle 409 on session create as "already imported" (continue with finals/runs/audio). This implements the "One-shot legacy data import from browser storage to backend" requirement. Verify via `frontend/src/ui/import-legacy.test.ts` covering: full success case, mid-batch failure preserves stores, re-run is no-op, 409 treated as skip.
- [x] 7.2 Add a "Migration" section to `frontend/src/ui/settings-panel.ts` with an "Import legacy data" button + status text element, implementing the design's "Settings panel — Import legacy data" UI. Button is disabled when `localStorage.getItem("whisper-wrap.sessions") === null` AND IDB `count()` returns 0. Wire `onclick` to call `importLegacyData(...)` with deps assembled in main.ts. Verify the button + status render in `frontend/src/ui/actions-and-settings.test.ts::test_migration_section_renders`.
- [x] 7.3 Add new i18n keys to `frontend/src/i18n/strings.ts` (en + zh-TW): `settings.migrationSection`, `settings.importLegacyButton`, `settings.importLegacyDisabledHint`, `settings.importLegacyResult` (with `{sessionsImported, audiosImported, errors}` placeholders), `settings.importLegacyError`. Verify via `frontend/src/i18n/index.test.ts` exhaustiveness check (TypeScript types fail compilation if any locale misses a key).

## 8. Final integration + commit — Acceptance criteria

- [x] 8.1 Full test suite green per the design's "Acceptance criteria" section: `uv run pytest -q` (expect at least 320 passed) AND `cd frontend && bun run test` (expect at least 160 passed). Document the counts in the commit body.
- [x] 8.2 `make build-frontend` succeeds; visit `/app/` and smoke test: start a Batch recording, stop, see transcript, click a chip, see AI answer, see new session in right-side history, expand the session, replay audio (loads from backend), delete the session (gone from history AND `data/audio/<id>.webm` removed). Document the smoke pass in the commit body.
- [ ] 8.3 Stage all changes and commit on `feat/history-persistence-sqlite` branch with a comprehensive commit message summarising the new backend capability, frontend swap, and migration tool. No `git push` (user verifies first).
