## Summary

Replace the browser-side persistence stack (localStorage for sessions, IndexedDB for audio blobs) with a SQLite-backed backend, so history data survives browser wipes, syncs across devices that point at the same backend, and gains analytical query power.

## Motivation

The current PWA stores all per-session data — transcript finals, AI action runs, raw audio blobs — entirely client-side. Three concrete pain points are accumulating:

1. **Storage ceiling**: iOS Safari evicts IndexedDB under storage pressure; audio blobs (~2 MB/min PCM) hit the quota quickly. The recent `audio-replay-and-re-asr` change shipped explicit audio budget controls precisely because the browser is a hostile storage host.
2. **No cross-device continuity**: A session captured on the laptop is invisible on the phone, even though both PWAs talk to the same backend. Users running whisper-wrap as a single-user local service expect their history to live on the server, not the device.
3. **No analytical leverage**: Questions like "which chip do I use most" or "show transcripts mentioning X" are infeasible against a localStorage-string-blob. SQLite + a small index unlocks these for free.

Moving the source of truth server-side also makes backups trivial (copy a `.db` file plus an `audio/` directory) and lets future spec changes — search, multi-user, sync — build on a real storage layer instead of fighting browser quotas.

## Proposed Solution

Introduce a new backend persistence capability backed by SQLAlchemy 2.0 + SQLite. Raw audio is stored on the filesystem under `data/audio/<session_id>.<ext>` with only the relative path recorded in the database; SQLite BLOB is intentionally avoided because it makes `vacuum` and backup operations slow on large rows.

Frontend `HistoryStore` keeps its public surface (`list`, `startSession`, `appendFinal`, `appendActionRun`, `stopSession`, `deleteSession`, `setRetention`) but the method bodies become `async` HTTP calls against the new endpoints. `main.ts` adapts the small number of synchronous call sites to `await` them. The frontend `AudioStore` (IndexedDB wrapper) is retired in favour of `POST /v1/sessions/{id}/audio` for uploads and `GET /v1/sessions/{id}/audio` for streaming playback.

A one-shot **Import legacy data** action in the Settings panel walks the existing `localStorage["whisper-wrap.sessions"]` JSON tree and the `whisper-wrap-audio` IndexedDB store, batches them into POST requests against the new backend, then clears the client storage on success. The action is idempotent (re-running after a successful import is a no-op because the local stores are already empty) and surfaces per-session error toasts so a partial failure is recoverable.

Alembic owns schema versioning; the v1 baseline migration creates the tables, and the lifespan handler runs `alembic upgrade head` at startup so a fresh install is one command from running.

## Non-Goals

- **Multi-user authentication**: This change assumes the single-user local install pattern (whisper-wrap binds to localhost or a tailnet). Auth/RBAC is a separate future capability.
- **Realtime sync push**: Devices pull fresh state from `GET /v1/sessions` on load and after writes; no WebSocket fan-out. Cross-device latency = next page refresh.
- **Server-side AI run replay or analytics dashboard**: The new schema makes these possible, but the UI for them is out of scope. This change only ships the data layer + lifecycle parity with the current PWA.
- **Encryption at rest**: SQLite is a plain file; protecting it is the deployer's responsibility (filesystem perms, full-disk encryption). No SQLCipher integration.
- **Removing the audio budget setting**: The setting becomes moot once backend storage replaces IDB, but ripping it out is a follow-up cleanup — keep it inert in this change to keep the migration small.

## Alternatives Considered

- **Audio as SQLite BLOB**: Avoided. SQLite handles small BLOBs fine but a 50 MB audio row inflates the db file unpredictably and breaks streaming (BLOBs are fetched as a single buffer). Filesystem with path-in-DB is the standard pattern (Apple Photos, iMessage, etc.).
- **Backend-only, no client cache**: Considered. Rejected because the existing PWA UX relies on synchronous `list()` returning instantly; making every render `await fetch` would introduce visible flicker on first paint. The chosen design keeps an in-memory cache in `HistoryStore` populated by the initial GET, then writes-through to the API.
- **Keep IndexedDB for audio, only move metadata to SQLite**: Considered. Rejected because audio is exactly the data that suffers from browser eviction. Moving metadata but not audio would leave the worst pain unaddressed.

## Impact

- Affected specs:
  - New: `history-persistence` (the new backend capability — schema, endpoints, lifecycle)
  - Modified: `pwa-audio-replay` (audio storage moves from IndexedDB to backend; replay fetches from backend instead of IDB lookup)
- Affected code:
  - New:
    - app/services/persistence/__init__.py
    - app/services/persistence/engine.py
    - app/services/persistence/models.py
    - app/services/persistence/sessions_repo.py
    - app/api/sessions.py
    - alembic.ini
    - alembic/env.py
    - alembic/versions/0001_initial_schema.py
    - frontend/src/storage/history-api-client.ts
    - frontend/src/ui/import-legacy.ts
    - tests/test_persistence_models.py
    - tests/test_sessions_api.py
    - frontend/src/storage/history-api-client.test.ts
    - frontend/src/ui/import-legacy.test.ts
  - Modified:
    - app/main.py
    - app/config.py
    - frontend/src/storage/history-store.ts
    - frontend/src/main.ts
    - frontend/src/ui/settings-panel.ts
    - frontend/src/ui/history-panel.ts
    - frontend/src/i18n/strings.ts
    - frontend/package.json
    - pyproject.toml
  - Removed:
    - frontend/src/storage/audio-store.ts
    - frontend/src/storage/audio-store.test.ts
