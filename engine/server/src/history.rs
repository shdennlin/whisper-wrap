//! /v1/sessions + /v1/meetings — persisted capture history.
//! Port of `app/api/sessions.py` + `app/api/meeting_history.py`.
//! Uses the SAME `data/history.db` SQLite file and schema as v2
//! (CREATE TABLE IF NOT EXISTS mirrors the alembic migrations), so
//! existing v2 history shows up in v3 unchanged.

use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Multipart, Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use crate::routes::ApiError;
use crate::state::AppState;

pub struct HistoryDb {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(36) PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    mode VARCHAR(8) NOT NULL CHECK (mode IN ('batch','live')),
    audio_path TEXT,
    audio_mime_type VARCHAR(64),
    audio_size_bytes INTEGER,
    duration_ms INTEGER,
    -- Item metadata (item-metadata); also back-filled by guarded ALTER for
    -- databases whose tables predate these columns.
    title TEXT,
    starred INTEGER NOT NULL DEFAULT 0,
    project TEXT,
    category TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions (started_at);
CREATE TABLE IF NOT EXISTS finals (
    session_id VARCHAR(36) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_ms INTEGER,
    end_ms INTEGER,
    kind VARCHAR(8),
    PRIMARY KEY (session_id, ord)
);
CREATE TABLE IF NOT EXISTS action_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id VARCHAR(36) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    action_id VARCHAR(64) NOT NULL,
    prompt TEXT NOT NULL,
    answer TEXT NOT NULL,
    ran_at INTEGER NOT NULL,
    model_used VARCHAR(128),
    succeeded BOOLEAN NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_action_runs_session ON action_runs (session_id);
CREATE INDEX IF NOT EXISTS idx_action_runs_action ON action_runs (action_id);
CREATE TABLE IF NOT EXISTS meeting_analyses (
    id VARCHAR(36) PRIMARY KEY,
    created_at INTEGER NOT NULL,
    filename TEXT NOT NULL,
    duration_seconds FLOAT,
    language VARCHAR(16),
    speakers_count INTEGER,
    result_json TEXT NOT NULL,
    speaker_names_json TEXT NOT NULL DEFAULT '{}',
    status VARCHAR(16) NOT NULL DEFAULT 'done',
    audio_path TEXT,
    audio_mime_type VARCHAR(64),
    audio_size_bytes INTEGER,
    -- Item metadata (item-metadata); see sessions above.
    title TEXT,
    starred INTEGER NOT NULL DEFAULT 0,
    project TEXT,
    category TEXT
);
CREATE INDEX IF NOT EXISTS idx_meeting_analyses_created ON meeting_analyses (created_at);
-- v3 Item/Runs ledger (run-job-foundation, D1). Additive + idempotent so the
-- still-shipping v2 product, which never references `runs`, opens this db
-- unchanged. One table for every run kind; the full result stays in its own
-- table (e.g. meeting_analyses) and is reached via result_ref (D3).
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('transcribe','diarize','ai')),
    model TEXT,
    params TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','error','cancelled')),
    progress REAL NOT NULL DEFAULT 0,
    stage TEXT,
    result_ref TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    -- Immutable per-run result snapshot (stage-run-endpoints, D1). A run keeps
    -- its own output here so re-running appends a kept version. Reached via the
    -- guarded ALTER below for databases whose `runs` predates this column.
    result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_item ON runs (item_id);
"#;

/// Add `col` to `table` only when it is absent — a presence-checked,
/// idempotent stand-in for the non-idempotent `ALTER TABLE ADD COLUMN`.
fn ensure_column(conn: &Connection, table: &str, col: &str, decl: &str) -> rusqlite::Result<()> {
    let present: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
        params![col],
        |r| r.get(0),
    )?;
    if present == 0 {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {decl};"))?;
    }
    Ok(())
}

impl HistoryDb {
    pub fn open(data_dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let conn = Connection::open(data_dir.join("history.db"))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(SCHEMA)?;
        // Upgrade path: databases whose `runs` table was created by
        // run-job-foundation lack `result_json`. `ALTER ADD COLUMN` is not
        // idempotent like `CREATE TABLE IF NOT EXISTS`, so add it only when
        // absent (a fresh db already has it from SCHEMA above).
        ensure_column(&conn, "runs", "result_json", "TEXT")?;
        // Item metadata (item-metadata): a uniform mutable surface on both item
        // tables. Guarded so v2-shaped databases gain the columns once.
        for table in ["sessions", "meeting_analyses"] {
            ensure_column(&conn, table, "title", "TEXT")?;
            ensure_column(&conn, table, "starred", "INTEGER NOT NULL DEFAULT 0")?;
            ensure_column(&conn, table, "project", "TEXT")?;
            ensure_column(&conn, table, "category", "TEXT")?;
        }
        Ok(HistoryDb {
            conn: Mutex::new(conn),
        })
    }

    /// `pub(crate)` so the `runs` ledger (runs.rs) shares this single
    /// connection to `history.db` rather than opening a second handle to
    /// the same file (which would invite SQLITE_BUSY).
    pub(crate) fn with<T>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, ApiError> {
        let conn = self.conn.lock().expect("db lock");
        f(&conn).map_err(ApiError::internal)
    }
}

/// Audio MIME allowlist — mirrors v2's `_MIME_TO_EXT`. Doubles as the
/// extension map for stored files and as the serve-side gate: a mime
/// outside this list is never echoed back in a Content-Type header
/// (stored XSS via `text/html` upload + inline replay).
fn allowed_ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime.to_lowercase().as_str() {
        "audio/webm" => Some(".webm"),
        "audio/mp4" | "audio/x-m4a" => Some(".m4a"),
        "audio/ogg" => Some(".ogg"),
        "audio/wav" | "audio/x-wav" | "audio/wave" => Some(".wav"),
        "audio/mpeg" => Some(".mp3"),
        "audio/aac" => Some(".aac"),
        "audio/flac" => Some(".flac"),
        "audio/opus" => Some(".opus"),
        _ => None,
    }
}

fn ext_for_mime(mime: &str) -> &'static str {
    allowed_ext_for_mime(mime).unwrap_or(".bin")
}

/// Allowlist for ids that get interpolated into filesystem paths:
/// alphanumerics, `_`, `-` only — blocks `..`, `/`, NUL, etc.
fn valid_fs_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 36
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A stored audio path is only trusted for fs read/unlink when it
/// canonicalizes to a location inside the configured audio dir.
fn audio_path_in_dir(path: &str, audio_dir: &Path) -> bool {
    let Ok(canon) = std::fs::canonicalize(path) else {
        return false;
    };
    let Ok(dir) = std::fs::canonicalize(audio_dir) else {
        return false;
    };
    canon.starts_with(dir)
}

fn safe_unlink(path: &str, audio_dir: &Path) {
    if audio_path_in_dir(path, audio_dir) {
        let _ = std::fs::remove_file(path);
    } else {
        log::warn!("refusing to unlink audio path outside audio dir: {path:?}");
    }
}

fn not_found(what: &str) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, format!("{what} not found"))
}

// ---------- sessions: row serialisation ----------

fn session_full(conn: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
    let row = conn
        .query_row(
            "SELECT id, started_at, ended_at, mode, audio_path, audio_mime_type, audio_size_bytes, duration_ms, title, starred, project, category FROM sessions WHERE id = ?1",
            params![id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "started_at": r.get::<_, i64>(1)?,
                    "ended_at": r.get::<_, Option<i64>>(2)?,
                    "mode": r.get::<_, String>(3)?,
                    "audio_path": r.get::<_, Option<String>>(4)?,
                    "audio_mime_type": r.get::<_, Option<String>>(5)?,
                    "audio_size_bytes": r.get::<_, Option<i64>>(6)?,
                    "duration_ms": r.get::<_, Option<i64>>(7)?,
                    "title": r.get::<_, Option<String>>(8)?,
                    "starred": r.get::<_, i64>(9)? != 0,
                    "project": r.get::<_, Option<String>>(10)?,
                    "category": r.get::<_, Option<String>>(11)?,
                }))
            },
        )
        .optional()?;
    let Some(mut row) = row else { return Ok(None) };

    let mut stmt = conn.prepare(
        "SELECT session_id, ord, text, start_ms, end_ms, kind FROM finals WHERE session_id = ?1 ORDER BY ord",
    )?;
    let finals: Vec<Value> = stmt
        .query_map(params![id], |r| {
            Ok(json!({
                "session_id": r.get::<_, String>(0)?,
                "ord": r.get::<_, i64>(1)?,
                "text": r.get::<_, String>(2)?,
                "start_ms": r.get::<_, Option<i64>>(3)?,
                "end_ms": r.get::<_, Option<i64>>(4)?,
                "kind": r.get::<_, Option<String>>(5)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;

    let mut stmt = conn.prepare(
        "SELECT id, session_id, action_id, prompt, answer, ran_at, model_used, succeeded FROM action_runs WHERE session_id = ?1 ORDER BY id",
    )?;
    let runs: Vec<Value> = stmt
        .query_map(params![id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "session_id": r.get::<_, String>(1)?,
                "action_id": r.get::<_, String>(2)?,
                "prompt": r.get::<_, String>(3)?,
                "answer": r.get::<_, String>(4)?,
                "ran_at": r.get::<_, i64>(5)?,
                "model_used": r.get::<_, Option<String>>(6)?,
                "succeeded": r.get::<_, bool>(7)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;

    row["finals"] = Value::Array(finals);
    row["action_runs"] = Value::Array(runs);
    Ok(Some(row))
}

// ---------- sessions: endpoints ----------

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListQuery {
    #[serde(default = "default_limit")]
    limit: i64,
    before_ms: Option<i64>,
    // Item-metadata filters (item-metadata). Absent = no filter; a non-boolean
    // `starred` is treated as absent rather than erroring.
    category: Option<String>,
    starred: Option<String>,
    project: Option<String>,
}

/// Build the filtered id page for an item list, shared by sessions and
/// meetings (item-metadata D4). `table` and `cursor_col` are fixed literals,
/// never user input; the metadata filters bind as parameters.
fn list_item_ids(
    conn: &Connection,
    table: &str,
    cursor_col: &str,
    q: &ListQuery,
    limit: i64,
) -> rusqlite::Result<Vec<String>> {
    let mut conds: Vec<String> = Vec::new();
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(b) = q.before_ms {
        conds.push(format!("{cursor_col} < ?"));
        args.push(Box::new(b));
    }
    if let Some(c) = q.category.clone() {
        conds.push("category = ?".into());
        args.push(Box::new(c));
    }
    match q.starred.as_deref() {
        Some("true") | Some("1") => {
            conds.push("starred = ?".into());
            args.push(Box::new(1i64));
        }
        Some("false") | Some("0") => {
            conds.push("starred = ?".into());
            args.push(Box::new(0i64));
        }
        _ => {} // absent or non-boolean -> no starred filter
    }
    if let Some(p) = q.project.clone() {
        conds.push("project = ?".into());
        args.push(Box::new(p));
    }
    let where_clause = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    let sql = format!("SELECT id FROM {table} {where_clause} ORDER BY {cursor_col} DESC LIMIT ?");
    args.push(Box::new(limit));
    let mut stmt = conn.prepare(&sql)?;
    let ids = stmt
        .query_map(
            rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())),
            |r| r.get::<_, String>(0),
        )?
        .collect();
    ids
}

fn default_limit() -> i64 {
    20
}

#[utoipa::path(
    get,
    path = "/v1/sessions",
    tag = "history",
    params(ListQuery),
    responses(
        (status = 200, description = "Paged session list with item-metadata filters applied (ad-hoc JSON)."),
        (status = 500, description = "History store error.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn list_sessions(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = q.limit.clamp(1, 100);
    let ids: Vec<String> = state
        .history
        .with(|conn| list_item_ids(conn, "sessions", "started_at", &q, limit))?;

    let mut sessions = Vec::new();
    let mut last_started: Option<i64> = None;
    for id in &ids {
        if let Some(full) = state.history.with(|c| session_full(c, id))? {
            last_started = full["started_at"].as_i64();
            sessions.push(full);
        }
    }
    let next = if sessions.len() as i64 == limit {
        last_started
    } else {
        None
    };
    Ok(Json(
        json!({ "sessions": sessions, "next_before_ms": next }),
    ))
}

#[utoipa::path(
    get,
    path = "/v1/sessions/{id}",
    tag = "history",
    params(("id" = String, Path, description = "Session id.")),
    responses(
        (status = 200, description = "The session with its items and finals (ad-hoc JSON)."),
        (status = 404, description = "No session with that id.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn get_session(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    state
        .history
        .with(|c| session_full(c, &id))?
        .map(Json)
        .ok_or_else(|| not_found("session"))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct SessionCreate {
    id: String,
    started_at: i64,
    mode: String,
}

#[utoipa::path(
    post,
    path = "/v1/sessions",
    tag = "history",
    request_body(content = SessionCreate, description = "New session metadata."),
    responses(
        (status = 200, description = "Session created (ad-hoc JSON with the new id)."),
        (status = 400, description = "Malformed body.", body = crate::routes::ApiErrorBody),
        (status = 500, description = "History store error.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn create_session(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SessionCreate>,
) -> Result<Response, ApiError> {
    if !valid_fs_id(&body.id) || !["batch", "live"].contains(&body.mode.as_str()) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid session payload",
        ));
    }
    let inserted = state.history.with(|c| {
        match c.execute(
            "INSERT INTO sessions (id, started_at, mode) VALUES (?1, ?2, ?3)",
            params![body.id, body.started_at, body.mode],
        ) {
            Ok(_) => Ok(true),
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Ok(false)
            }
            Err(e) => Err(e),
        }
    })?;
    if !inserted {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "session id already exists",
        ));
    }
    let full = state
        .history
        .with(|c| session_full(c, &body.id))?
        .expect("just inserted");
    state.notify_sessions_changed();
    Ok((StatusCode::CREATED, Json(full)).into_response())
}

/// `GET /v1/sessions/events` — Server-Sent Events stream (live-library-push).
///
/// Emits an `event: changed` frame whenever a session is created, finalized, or
/// appended to, so any open frontend window refreshes in real time. Frames
/// carry no session data; clients re-fetch via the list/detail endpoints. A
/// `ready` frame is sent on connect so the client can confirm the stream is
/// live, and `KeepAlive` injects comment heartbeats so idle connections survive
/// proxy timeouts. A subscriber that lags past the channel capacity gets one
/// catch-up `changed` rather than an error.
#[utoipa::path(
    get,
    path = "/v1/sessions/events",
    tag = "history",
    description = "Server-Sent Events stream of session-list changes. On connect \
        the server emits a `ready` event, then a `changed` event whenever any \
        session is created, updated, or deleted; comment heartbeats keep idle \
        connections alive. Clients re-fetch `GET /v1/sessions` on each `changed`.",
    responses(
        (status = 200, description = "An SSE stream of `ready` then `changed` events.", content_type = "text/event-stream")
    )
)]
pub async fn stream_session_events(State(state): State<Arc<AppState>>) -> Response {
    let mut rx = state.sessions_changed.subscribe();
    let stream = async_stream::stream! {
        yield Ok::<_, Infallible>(Event::default().event("ready").data("{}"));
        loop {
            match rx.recv().await {
                Ok(()) => yield Ok(Event::default().event("changed").data("{}")),
                // Lagged = we dropped some pings under load; one catch-up frame
                // is enough since the client re-fetches the whole list anyway.
                Err(RecvError::Lagged(_)) => {
                    yield Ok(Event::default().event("changed").data("{}"))
                }
                Err(RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(25)))
        .into_response()
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct SessionPatch {
    ended_at: Option<i64>,
    duration_ms: Option<i64>,
    audio_path: Option<String>,
    audio_mime_type: Option<String>,
    audio_size_bytes: Option<i64>,
    // Item metadata (item-metadata) — partial: omitted fields stay unchanged.
    title: Option<String>,
    starred: Option<bool>,
    project: Option<String>,
    category: Option<String>,
}

#[utoipa::path(
    patch,
    path = "/v1/sessions/{id}",
    tag = "history",
    params(("id" = String, Path, description = "Session id.")),
    request_body(content = SessionPatch, description = "Partial session update (title, item metadata, …)."),
    responses(
        (status = 200, description = "Updated session (ad-hoc JSON)."),
        (status = 400, description = "Malformed body.", body = crate::routes::ApiErrorBody),
        (status = 404, description = "No session with that id.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn patch_session(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<SessionPatch>,
) -> Result<Json<Value>, ApiError> {
    // Security: audio_path is server-managed (set only by the upload
    // handler). A client-supplied value would enable arbitrary file
    // read/unlink through the audio endpoints — accept-and-ignore so
    // the v2 PATCH contract keeps working.
    if body.audio_path.is_some() {
        log::warn!("PATCH /v1/sessions/{id}: client-supplied audio_path ignored");
    }
    let n = state.history.with(|c| {
        c.execute(
            "UPDATE sessions SET
               ended_at = COALESCE(?2, ended_at),
               duration_ms = COALESCE(?3, duration_ms),
               audio_mime_type = COALESCE(?4, audio_mime_type),
               audio_size_bytes = COALESCE(?5, audio_size_bytes),
               title = COALESCE(?6, title),
               starred = COALESCE(?7, starred),
               project = COALESCE(?8, project),
               category = COALESCE(?9, category)
             WHERE id = ?1",
            params![
                id,
                body.ended_at,
                body.duration_ms,
                body.audio_mime_type,
                body.audio_size_bytes,
                body.title,
                body.starred,
                body.project,
                body.category
            ],
        )
    })?;
    if n == 0 {
        return Err(not_found("session"));
    }
    let full = state
        .history
        .with(|c| session_full(c, &id))?
        .expect("updated");
    state.notify_sessions_changed();
    Ok(Json(full))
}

#[utoipa::path(
    delete,
    path = "/v1/sessions/{id}",
    tag = "history",
    params(("id" = String, Path, description = "Session id.")),
    responses(
        (status = 200, description = "Session deleted."),
        (status = 404, description = "No session with that id.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn delete_session(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, ApiError> {
    let audio: Option<String> = state
        .history
        .with(|c| {
            c.query_row(
                "SELECT audio_path FROM sessions WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()
        })?
        .ok_or_else(|| not_found("session"))?;
    state
        .history
        .with(|c| c.execute("DELETE FROM sessions WHERE id = ?1", params![id]))?;
    if let Some(p) = audio {
        safe_unlink(&p, &state.config.audio_dir());
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct FinalIn {
    text: String,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    kind: Option<String>,
}

#[utoipa::path(
    post,
    path = "/v1/sessions/{id}/finals",
    tag = "history",
    params(("id" = String, Path, description = "Session id.")),
    request_body(content = FinalIn, description = "A finalized transcript segment to append to the session."),
    responses(
        (status = 200, description = "Segment appended."),
        (status = 400, description = "Malformed body.", body = crate::routes::ApiErrorBody),
        (status = 404, description = "No session with that id.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn append_final(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<FinalIn>,
) -> Result<Response, ApiError> {
    ensure_session(&state, &id)?;
    let ord: i64 = state.history.with(|c| {
        let ord: i64 = c.query_row(
            "SELECT COALESCE(MAX(ord), -1) + 1 FROM finals WHERE session_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        c.execute(
            "INSERT INTO finals (session_id, ord, text, start_ms, end_ms, kind) VALUES (?1,?2,?3,?4,?5,?6)",
            params![id, ord, body.text, body.start_ms, body.end_ms, body.kind],
        )?;
        Ok(ord)
    })?;
    state.notify_sessions_changed();
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "session_id": id, "ord": ord, "text": body.text,
            "start_ms": body.start_ms, "end_ms": body.end_ms, "kind": body.kind,
        })),
    )
        .into_response())
}

// The v2 action_runs write handlers (append_run / delete_run) are retired
// (retire-v2-recording-shell): action_runs is a read-only legacy source,
// surfaced only via legacy-origin synthesis in the unified run listing.

fn ensure_session(state: &AppState, id: &str) -> Result<(), ApiError> {
    let exists: Option<i64> = state.history.with(|c| {
        c.query_row("SELECT 1 FROM sessions WHERE id = ?1", params![id], |r| {
            r.get(0)
        })
        .optional()
    })?;
    exists.map(|_| ()).ok_or_else(|| not_found("session"))
}

// ---------- sessions: audio ----------

#[utoipa::path(
    post,
    path = "/v1/sessions/{id}/audio",
    tag = "history",
    params(("id" = String, Path, description = "Session id.")),
    request_body(
        content_type = "multipart/form-data",
        description = "Multipart upload carrying the session's audio blob in a `file` part.",
        content = Vec<u8>
    ),
    responses(
        (status = 200, description = "Audio stored (ad-hoc JSON)."),
        (status = 400, description = "Missing or malformed upload.", body = crate::routes::ApiErrorBody),
        (status = 404, description = "No session with that id.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn upload_session_audio(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    if !valid_fs_id(&id) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid session id",
        ));
    }
    ensure_session(&state, &id)?;
    let (body, mime) = read_file_field(multipart).await?;
    let old: Option<String> = state.history.with(|c| {
        c.query_row(
            "SELECT audio_path FROM sessions WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
    })?;
    if let Some(old) = old {
        safe_unlink(&old, &state.config.audio_dir());
    }
    state
        .config
        .ensure_data_dirs()
        .map_err(ApiError::internal)?;
    let target: PathBuf = state
        .config
        .audio_dir()
        .join(format!("{id}{}", ext_for_mime(&mime)));
    std::fs::write(&target, &body).map_err(ApiError::internal)?;
    let rel = target.to_string_lossy().into_owned();
    state.history.with(|c| {
        c.execute(
            "UPDATE sessions SET audio_path=?2, audio_mime_type=?3, audio_size_bytes=?4 WHERE id=?1",
            params![id, rel, mime, body.len() as i64],
        )
    })?;
    Ok(Json(json!({
        "audio_path": rel, "audio_size_bytes": body.len(), "audio_mime_type": mime,
    })))
}

#[utoipa::path(
    get,
    path = "/v1/sessions/{id}/audio",
    tag = "history",
    params(("id" = String, Path, description = "Session id.")),
    responses(
        (status = 200, description = "The stored audio blob (binary, original media type).", content_type = "application/octet-stream"),
        (status = 404, description = "No session or no stored audio for that id.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn stream_session_audio(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, ApiError> {
    let (path, mime): (Option<String>, Option<String>) = state
        .history
        .with(|c| {
            c.query_row(
                "SELECT audio_path, audio_mime_type FROM sessions WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
        })?
        .ok_or_else(|| not_found("session"))?;
    serve_audio(path, mime, &state.config.audio_dir())
}

#[utoipa::path(
    delete,
    path = "/v1/sessions/audio",
    tag = "history",
    responses(
        (status = 200, description = "Cleared stored audio blobs across sessions (ad-hoc JSON summary)."),
        (status = 500, description = "History store error.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn bulk_clear_audio(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let paths: Vec<String> = state.history.with(|c| {
        let mut stmt = c.prepare("SELECT audio_path FROM sessions WHERE audio_path IS NOT NULL")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        c.execute(
            "UPDATE sessions SET audio_path=NULL, audio_mime_type=NULL, audio_size_bytes=NULL",
            [],
        )?;
        Ok(rows)
    })?;
    let mut count = 0;
    let audio_dir = state.config.audio_dir();
    for p in paths {
        if audio_path_in_dir(&p, &audio_dir) && std::fs::remove_file(&p).is_ok() {
            count += 1;
        }
    }
    Ok(Json(json!({ "deleted_count": count })))
}

fn serve_audio(
    path: Option<String>,
    mime: Option<String>,
    audio_dir: &Path,
) -> Result<Response, ApiError> {
    let Some(path) = path.filter(|p| Path::new(p).exists()) else {
        return Err(not_found("audio"));
    };
    if !audio_path_in_dir(&path, audio_dir) {
        log::warn!("refusing to serve audio path outside audio dir: {path:?}");
        return Err(not_found("audio"));
    }
    let bytes = std::fs::read(&path).map_err(ApiError::internal)?;
    // Serve-side mime gate (v2 parity): only allowlisted audio types
    // are echoed back; anything else (legacy rows, tampered DB) falls
    // back to octet-stream so the browser never parses it as HTML.
    let mime = mime
        .filter(|m| allowed_ext_for_mime(m).is_some())
        .unwrap_or_else(|| "application/octet-stream".into());
    let filename = Path::new(&path)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (
                header::CONTENT_DISPOSITION,
                format!("inline; filename=\"{filename}\""),
            ),
            // Belt-and-braces: even with a safe Content-Type, forbid
            // mime sniffing of HTML-looking byte prefixes.
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
        ],
        bytes,
    )
        .into_response())
}

async fn read_file_field(mut multipart: Multipart) -> Result<(Vec<u8>, String), ApiError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?
    {
        if field.name() == Some("file") {
            let mime = field
                .content_type()
                .unwrap_or("application/octet-stream")
                .to_owned();
            let bytes = field
                .bytes()
                .await
                .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
            return Ok((bytes.to_vec(), mime));
        }
    }
    Err(ApiError::new(
        StatusCode::BAD_REQUEST,
        "Missing form field 'file'",
    ))
}

// ---------- meetings ----------

fn meeting_full(conn: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
    conn.query_row(
        "SELECT id, created_at, filename, duration_seconds, language, speakers_count, result_json, speaker_names_json, status, audio_path, audio_mime_type, audio_size_bytes, title, starred, project, category FROM meeting_analyses WHERE id = ?1",
        params![id],
        |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "created_at": r.get::<_, i64>(1)?,
                "filename": r.get::<_, String>(2)?,
                "duration_seconds": r.get::<_, Option<f64>>(3)?,
                "language": r.get::<_, Option<String>>(4)?,
                "speakers_count": r.get::<_, Option<i64>>(5)?,
                "result": serde_json::from_str::<Value>(&r.get::<_, String>(6)?).unwrap_or(Value::Null),
                "speaker_names": serde_json::from_str::<Value>(&r.get::<_, String>(7)?).unwrap_or(json!({})),
                "status": r.get::<_, String>(8)?,
                "audio_path": r.get::<_, Option<String>>(9)?,
                "audio_mime_type": r.get::<_, Option<String>>(10)?,
                "audio_size_bytes": r.get::<_, Option<i64>>(11)?,
                "title": r.get::<_, Option<String>>(12)?,
                "starred": r.get::<_, i64>(13)? != 0,
                "project": r.get::<_, Option<String>>(14)?,
                "category": r.get::<_, Option<String>>(15)?,
            }))
        },
    )
    .optional()
}

#[utoipa::path(
    get,
    path = "/v1/meetings",
    tag = "history",
    params(ListQuery),
    responses(
        (status = 200, description = "Paged meeting list with item-metadata filters applied (ad-hoc JSON)."),
        (status = 500, description = "History store error.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn list_meetings(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = q.limit.clamp(1, 100);
    let ids: Vec<String> = state
        .history
        .with(|c| list_item_ids(c, "meeting_analyses", "created_at", &q, limit))?;
    let mut meetings = Vec::new();
    let mut last: Option<i64> = None;
    for id in &ids {
        if let Some(m) = state.history.with(|c| meeting_full(c, id))? {
            last = m["created_at"].as_i64();
            meetings.push(m);
        }
    }
    let next = if meetings.len() as i64 == limit {
        last
    } else {
        None
    };
    Ok(Json(
        json!({ "meetings": meetings, "next_before_ms": next }),
    ))
}

#[utoipa::path(
    get,
    path = "/v1/meetings/{id}",
    tag = "history",
    params(("id" = String, Path, description = "Meeting id.")),
    responses(
        (status = 200, description = "The meeting with its items (ad-hoc JSON)."),
        (status = 404, description = "No meeting with that id.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn get_meeting(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    state
        .history
        .with(|c| meeting_full(c, &id))?
        .map(Json)
        .ok_or_else(|| not_found("meeting"))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct MeetingCreate {
    pub id: String,
    pub filename: String,
    pub result: Value,
    pub created_at: Option<i64>,
    pub duration_seconds: Option<f64>,
    pub language: Option<String>,
    pub speakers_count: Option<i64>,
    #[serde(default)]
    pub speaker_names: Value,
    #[serde(default = "default_done")]
    pub status: String,
}

fn default_done() -> String {
    "done".into()
}

fn valid_meeting_id(id: &str) -> bool {
    valid_fs_id(id)
}

pub fn insert_meeting(db: &HistoryDb, m: &MeetingCreate) -> Result<(), ApiError> {
    let created = m.created_at.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    });
    let names = if m.speaker_names.is_object() {
        m.speaker_names.to_string()
    } else {
        "{}".into()
    };
    db.with(|c| {
        c.execute(
            "INSERT OR REPLACE INTO meeting_analyses (id, created_at, filename, duration_seconds, language, speakers_count, result_json, speaker_names_json, status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![m.id, created, m.filename, m.duration_seconds, m.language, m.speakers_count, m.result.to_string(), names, m.status],
        )
    })?;
    Ok(())
}

#[utoipa::path(
    post,
    path = "/v1/meetings",
    tag = "history",
    request_body(content = MeetingCreate, description = "New meeting metadata."),
    responses(
        (status = 200, description = "Meeting created (ad-hoc JSON with the new id)."),
        (status = 400, description = "Malformed body.", body = crate::routes::ApiErrorBody),
        (status = 500, description = "History store error.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn create_meeting(
    State(state): State<Arc<AppState>>,
    Json(body): Json<MeetingCreate>,
) -> Result<Response, ApiError> {
    if !valid_meeting_id(&body.id) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid meeting id",
        ));
    }
    // The HTTP route enforces uniqueness with 409 (v2 contract); the
    // internal auto-persist path keeps INSERT OR REPLACE semantics.
    let exists: Option<i64> = state.history.with(|c| {
        c.query_row(
            "SELECT 1 FROM meeting_analyses WHERE id = ?1",
            params![body.id],
            |r| r.get(0),
        )
        .optional()
    })?;
    if exists.is_some() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "meeting id already exists",
        ));
    }
    insert_meeting(&state.history, &body)?;
    let full = state
        .history
        .with(|c| meeting_full(c, &body.id))?
        .expect("just inserted");
    Ok((StatusCode::CREATED, Json(full)).into_response())
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct MeetingPatch {
    speaker_names: Option<Value>,
    filename: Option<String>,
    // Item metadata (item-metadata) — partial: omitted fields stay unchanged.
    title: Option<String>,
    starred: Option<bool>,
    project: Option<String>,
    category: Option<String>,
}

#[utoipa::path(
    patch,
    path = "/v1/meetings/{id}",
    tag = "history",
    params(("id" = String, Path, description = "Meeting id.")),
    request_body(content = MeetingPatch, description = "Partial meeting update (title, item metadata, …)."),
    responses(
        (status = 200, description = "Updated meeting (ad-hoc JSON)."),
        (status = 400, description = "Malformed body.", body = crate::routes::ApiErrorBody),
        (status = 404, description = "No meeting with that id.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn patch_meeting(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<MeetingPatch>,
) -> Result<Json<Value>, ApiError> {
    if body.speaker_names.is_none()
        && body.filename.is_none()
        && body.title.is_none()
        && body.starred.is_none()
        && body.project.is_none()
        && body.category.is_none()
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "patch body must include at least one of: speaker_names, filename, title, starred, project, category",
        ));
    }
    let names = body.speaker_names.map(|v| v.to_string());
    let n = state.history.with(|c| {
        c.execute(
            "UPDATE meeting_analyses SET
               speaker_names_json = COALESCE(?2, speaker_names_json),
               filename = COALESCE(?3, filename),
               title = COALESCE(?4, title),
               starred = COALESCE(?5, starred),
               project = COALESCE(?6, project),
               category = COALESCE(?7, category)
             WHERE id = ?1",
            params![
                id,
                names,
                body.filename,
                body.title,
                body.starred,
                body.project,
                body.category
            ],
        )
    })?;
    if n == 0 {
        return Err(not_found("meeting"));
    }
    Ok(Json(
        state
            .history
            .with(|c| meeting_full(c, &id))?
            .expect("updated"),
    ))
}

#[utoipa::path(
    delete,
    path = "/v1/meetings/{id}",
    tag = "history",
    params(("id" = String, Path, description = "Meeting id.")),
    responses(
        (status = 200, description = "Meeting deleted."),
        (status = 404, description = "No meeting with that id.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn delete_meeting(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, ApiError> {
    let audio: Option<String> = state
        .history
        .with(|c| {
            c.query_row(
                "SELECT audio_path FROM meeting_analyses WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()
        })?
        .ok_or_else(|| not_found("meeting"))?;
    state
        .history
        .with(|c| c.execute("DELETE FROM meeting_analyses WHERE id = ?1", params![id]))?;
    if let Some(p) = audio {
        safe_unlink(&p, &state.config.audio_dir());
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[utoipa::path(
    post,
    path = "/v1/meetings/{id}/audio",
    tag = "history",
    params(("id" = String, Path, description = "Meeting id.")),
    request_body(
        content_type = "multipart/form-data",
        description = "Multipart upload carrying the meeting's audio blob in a `file` part.",
        content = Vec<u8>
    ),
    responses(
        (status = 200, description = "Audio stored (ad-hoc JSON)."),
        (status = 400, description = "Missing or malformed upload.", body = crate::routes::ApiErrorBody),
        (status = 404, description = "No meeting with that id.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn upload_meeting_audio(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    if !valid_meeting_id(&id) {
        // v2 returns 400 here (path-level re-validation), not 422.
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid meeting id"));
    }
    let exists: Option<String> = state.history.with(|c| {
        c.query_row(
            "SELECT audio_path FROM meeting_analyses WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|o| o.flatten())
    })?;
    if state
        .history
        .with(|c| {
            c.query_row(
                "SELECT 1 FROM meeting_analyses WHERE id = ?1",
                params![id],
                |r| r.get::<_, i64>(0),
            )
            .optional()
        })?
        .is_none()
    {
        return Err(not_found("meeting"));
    }
    let (body, mime) = read_file_field(multipart).await?;
    // Upload-side mime allowlist (v2 parity): without this a client
    // could store `text/html` and have GET replay it as HTML.
    if allowed_ext_for_mime(&mime).is_none() {
        let shown = if mime.is_empty() { "<missing>" } else { &mime };
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("unsupported audio mime type: {shown}"),
        ));
    }
    if let Some(old) = exists {
        safe_unlink(&old, &state.config.audio_dir());
    }
    state
        .config
        .ensure_data_dirs()
        .map_err(ApiError::internal)?;
    let target = state
        .config
        .audio_dir()
        .join(format!("meeting-{id}{}", ext_for_mime(&mime)));
    std::fs::write(&target, &body).map_err(ApiError::internal)?;
    let rel = target.to_string_lossy().into_owned();
    state.history.with(|c| {
        c.execute(
            "UPDATE meeting_analyses SET audio_path=?2, audio_mime_type=?3, audio_size_bytes=?4 WHERE id=?1",
            params![id, rel, mime, body.len() as i64],
        )
    })?;
    Ok(Json(json!({
        "audio_path": rel, "audio_mime_type": mime, "audio_size_bytes": body.len(),
    })))
}

#[utoipa::path(
    get,
    path = "/v1/meetings/{id}/audio",
    tag = "history",
    params(("id" = String, Path, description = "Meeting id.")),
    responses(
        (status = 200, description = "The stored audio blob (binary, original media type).", content_type = "application/octet-stream"),
        (status = 404, description = "No meeting or no stored audio for that id.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn stream_meeting_audio(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, ApiError> {
    let (path, mime): (Option<String>, Option<String>) = state
        .history
        .with(|c| {
            c.query_row(
                "SELECT audio_path, audio_mime_type FROM meeting_analyses WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
        })?
        .ok_or_else(|| not_found("meeting"))?;
    serve_audio(path, mime, &state.config.audio_dir())
}

#[cfg(test)]
mod runs_migration_tests {
    //! Task 1.1: the `runs` table is created additively at `HistoryDb::open`
    //! and the migration leaves an existing v2-shaped database intact.
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ww-runs-mig-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create tmp");
        dir
    }

    fn column_names(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table_info");
        stmt.query_map([], |r| r.get::<_, String>(1))
            .expect("query table_info")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect columns")
    }

    #[test]
    fn open_creates_runs_table_with_contract_columns() {
        let dir = tmp("fresh");
        let db = HistoryDb::open(&dir).expect("open");
        let cols = db.with(|c| Ok(column_names(c, "runs"))).expect("columns");
        for expected in [
            "id",
            "item_id",
            "kind",
            "model",
            "params",
            "status",
            "progress",
            "stage",
            "result_ref",
            "error",
            "created_at",
            "updated_at",
        ] {
            assert!(
                cols.iter().any(|c| c == expected),
                "runs table missing column {expected:?}; got {cols:?}"
            );
        }
    }

    #[test]
    fn migration_preserves_v2_tables_and_rows() {
        let dir = tmp("v2compat");
        // A database that the still-shipping v2 product created: only the
        // v2 tables, plus a sample row that must survive the migration.
        {
            let conn = Connection::open(dir.join("history.db")).expect("v2 db");
            conn.execute_batch(
                r#"
                CREATE TABLE sessions (id VARCHAR(36) PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, mode VARCHAR(8) NOT NULL, audio_path TEXT, audio_mime_type VARCHAR(64), audio_size_bytes INTEGER, duration_ms INTEGER);
                CREATE TABLE finals (session_id VARCHAR(36) NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL, start_ms INTEGER, end_ms INTEGER, kind VARCHAR(8), PRIMARY KEY (session_id, ord));
                CREATE TABLE action_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id VARCHAR(36) NOT NULL, action_id VARCHAR(64) NOT NULL, prompt TEXT NOT NULL, answer TEXT NOT NULL, ran_at INTEGER NOT NULL, model_used VARCHAR(128), succeeded BOOLEAN NOT NULL DEFAULT 1);
                CREATE TABLE meeting_analyses (id VARCHAR(36) PRIMARY KEY, created_at INTEGER NOT NULL, filename TEXT NOT NULL, duration_seconds FLOAT, language VARCHAR(16), speakers_count INTEGER, result_json TEXT NOT NULL, speaker_names_json TEXT NOT NULL DEFAULT '{}', status VARCHAR(16) NOT NULL DEFAULT 'done', audio_path TEXT, audio_mime_type VARCHAR(64), audio_size_bytes INTEGER);
                "#,
            )
            .expect("seed v2 schema");
            conn.execute(
                "INSERT INTO sessions (id, started_at, mode) VALUES ('s1', 1000, 'batch')",
                [],
            )
            .expect("seed v2 row");
        }

        // Opening through HistoryDb runs the additive migration.
        let db = HistoryDb::open(&dir).expect("open migrates");
        let (has_runs, session_mode): (bool, String) = db
            .with(|c| {
                let has_runs = c
                    .query_row(
                        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='runs'",
                        [],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()?
                    .is_some();
                let mode: String =
                    c.query_row("SELECT mode FROM sessions WHERE id='s1'", [], |r| r.get(0))?;
                Ok((has_runs, mode))
            })
            .expect("query");
        assert!(has_runs, "migration must create the runs table");
        assert_eq!(session_mode, "batch", "v2 session row must survive intact");
    }

    #[test]
    fn migration_adds_result_json_to_a_pre_snapshot_runs_table() {
        // Task 1.1: a `runs` table created by run-job-foundation (no
        // result_json) gains the column on open, additively.
        let dir = tmp("result-json");
        {
            let conn = Connection::open(dir.join("history.db")).expect("db");
            conn.execute_batch(
                "CREATE TABLE runs (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, kind TEXT NOT NULL, model TEXT, params TEXT, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, stage TEXT, result_ref TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
            )
            .expect("seed pre-snapshot runs");
            conn.execute(
                "INSERT INTO runs (id, item_id, kind, status, progress, created_at, updated_at) VALUES ('r1','i1','diarize','done',1.0,1,2)",
                [],
            )
            .expect("seed run row");
        }

        let db = HistoryDb::open(&dir).expect("open migrates");
        let (has_col, item): (bool, String) = db
            .with(|c| {
                let has_col = c.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name='result_json'",
                    [],
                    |r| r.get::<_, i64>(0),
                )? > 0;
                let item: String =
                    c.query_row("SELECT item_id FROM runs WHERE id='r1'", [], |r| r.get(0))?;
                Ok((has_col, item))
            })
            .expect("query");
        assert!(
            has_col,
            "result_json column must be added to an existing runs table"
        );
        assert_eq!(item, "i1", "existing run row must survive the column add");
    }

    fn has_columns(db: &HistoryDb, table: &str, cols: &[&str]) -> bool {
        db.with(|c| {
            let mut ok = true;
            for col in cols {
                let n: i64 = c.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
                    params![table, col],
                    |r| r.get(0),
                )?;
                ok &= n > 0;
            }
            Ok(ok)
        })
        .unwrap()
    }

    #[test]
    fn migration_adds_metadata_columns_to_pre_metadata_item_tables() {
        // Task 1.1: v2-shaped sessions / meeting_analyses (no metadata) gain
        // title/starred/project/category on open, additively.
        let dir = tmp("item-metadata");
        {
            let conn = Connection::open(dir.join("history.db")).expect("db");
            conn.execute_batch(
                "CREATE TABLE sessions (id VARCHAR(36) PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, mode VARCHAR(8) NOT NULL, audio_path TEXT, audio_mime_type VARCHAR(64), audio_size_bytes INTEGER, duration_ms INTEGER);
                 CREATE TABLE meeting_analyses (id VARCHAR(36) PRIMARY KEY, created_at INTEGER NOT NULL, filename TEXT NOT NULL, duration_seconds FLOAT, language VARCHAR(16), speakers_count INTEGER, result_json TEXT NOT NULL, speaker_names_json TEXT NOT NULL DEFAULT '{}', status VARCHAR(16) NOT NULL DEFAULT 'done', audio_path TEXT, audio_mime_type VARCHAR(64), audio_size_bytes INTEGER);",
            )
            .expect("seed v2 item tables");
            conn.execute(
                "INSERT INTO sessions (id, started_at, mode) VALUES ('s1', 1, 'batch')",
                [],
            )
            .expect("seed session");
            conn.execute(
                "INSERT INTO meeting_analyses (id, created_at, filename, result_json) VALUES ('m1', 1, 'm.wav', '{}')",
                [],
            )
            .expect("seed meeting");
        }

        let db = HistoryDb::open(&dir).expect("open migrates");
        let meta = ["title", "starred", "project", "category"];
        assert!(
            has_columns(&db, "sessions", &meta),
            "sessions gains metadata columns"
        );
        assert!(
            has_columns(&db, "meeting_analyses", &meta),
            "meeting_analyses gains metadata columns"
        );
        // Existing rows survive.
        let (s, m): (String, String) = db
            .with(|c| {
                Ok((
                    c.query_row("SELECT mode FROM sessions WHERE id='s1'", [], |r| r.get(0))?,
                    c.query_row(
                        "SELECT filename FROM meeting_analyses WHERE id='m1'",
                        [],
                        |r| r.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!(s, "batch");
        assert_eq!(m, "m.wav");
    }
}
