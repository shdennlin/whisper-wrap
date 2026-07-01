//! `runs` ledger — the v3 Item/Runs foundation (run-job-foundation).
//!
//! A run is one execution of an operation (transcribe | diarize | ai) against
//! an item. Re-running APPENDS a new run; prior runs are never overwritten
//! (D1). The full result stays in its own table and is reached via `result_ref`
//! rather than duplicated here (D3). Every run reports through one status
//! contract (the job-status capability), readable by id at `GET /runs/{id}`
//! (D5) and surviving a process restart because the row is the durable mirror
//! of the in-memory job (D4).

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::history::HistoryDb;
use crate::routes::ApiError;
use crate::state::AppState;

/// The five lifecycle states every run reports (job-status contract).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Queued,
    Running,
    Done,
    Error,
    Cancelled,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Done => "done",
            RunStatus::Error => "error",
            RunStatus::Cancelled => "cancelled",
        }
    }

    fn parse(s: &str) -> Result<Self, String> {
        Ok(match s {
            "queued" => RunStatus::Queued,
            "running" => RunStatus::Running,
            "done" => RunStatus::Done,
            "error" => RunStatus::Error,
            "cancelled" => RunStatus::Cancelled,
            other => return Err(format!("unknown run status {other:?}")),
        })
    }
}

/// The operation a run records. The `runs` table is the eventual superset of
/// all three kinds; this change writes only `Diarize` (the meeting pipeline).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum RunKind {
    Transcribe,
    Diarize,
    Ai,
}

impl RunKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RunKind::Transcribe => "transcribe",
            RunKind::Diarize => "diarize",
            RunKind::Ai => "ai",
        }
    }

    fn parse(s: &str) -> Result<Self, String> {
        Ok(match s {
            "transcribe" => RunKind::Transcribe,
            "diarize" => RunKind::Diarize,
            "ai" => RunKind::Ai,
            other => return Err(format!("unknown run kind {other:?}")),
        })
    }
}

/// Provenance of a run in the item listing (unify-run-ledger). `Stage` is a
/// real row in the `runs` ledger; `Capture` and `Legacy` are read-only runs
/// synthesized at list time from a session's `finals` / legacy `action_runs`,
/// so a read surface sees one unified history without reconciling the storage
/// split. Synthesized runs are never re-runnable.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum RunOrigin {
    Stage,
    Capture,
    Legacy,
}

/// The job-status contract JSON returned by `GET /runs/{id}`. `params` is
/// stored in the table (D1) but deliberately NOT part of the status contract,
/// so it does not appear here.
#[derive(Clone, Debug, Serialize, Deserialize, utoipa::ToSchema)]
pub struct RunRecord {
    pub id: String,
    pub item_id: String,
    pub kind: RunKind,
    pub model: Option<String>,
    pub status: RunStatus,
    pub progress: f64,
    pub stage: Option<String>,
    pub result_ref: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// The run's immutable result snapshot (stage-run-endpoints, D8), parsed
    /// from `result_json`. Serialized as `result`: null when the run has no
    /// snapshot. Additive to the job-status contract.
    pub result: Option<serde_json::Value>,
    /// Provenance (unify-run-ledger): `stage` for a real ledger row,
    /// `capture`/`legacy` for a run synthesized at list time. Ledger reads are
    /// always `stage`; the synthesizers set the other two.
    pub origin: RunOrigin,
}

/// The `GET /items/{id}/runs` body: `{ "runs": RunRecord[] }`. A trivial
/// wrapper over the run list, reusing the already-typed `RunRecord` element so
/// the wire shape stays byte-identical to the prior `json!({ "runs": ... })`.
#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
pub struct ItemRunsResponse {
    pub runs: Vec<RunRecord>,
}

/// Fields needed to open a run. `status` is the caller's starting state — the
/// meeting pipeline opens at `Running` (D4).
pub struct RunInsert {
    pub item_id: String,
    pub kind: RunKind,
    pub model: Option<String>,
    pub params: Option<String>,
    pub status: RunStatus,
    pub stage: Option<String>,
    pub progress: f64,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

const SELECT_COLS: &str =
    "SELECT id, item_id, kind, model, status, progress, stage, result_ref, error, created_at, updated_at, result_json FROM runs";

/// Open a run (append-only): generates the run id, stamps created/updated.
/// Returns the new run id.
pub fn insert(db: &HistoryDb, run: RunInsert) -> Result<String, ApiError> {
    let id = ulid::Ulid::new().to_string();
    let now = now_unix();
    db.with(|c| {
        c.execute(
            "INSERT INTO runs (id, item_id, kind, model, params, status, progress, stage, result_ref, error, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL,NULL,?9,?9)",
            params![
                id,
                run.item_id,
                run.kind.as_str(),
                run.model,
                run.params,
                run.status.as_str(),
                run.progress,
                run.stage,
                now,
            ],
        )?;
        Ok(())
    })?;
    Ok(id)
}

/// Write through an in-flight progress/stage update (D4).
pub fn update_progress(
    db: &HistoryDb,
    run_id: &str,
    progress: f64,
    stage: &str,
) -> Result<(), ApiError> {
    let now = now_unix();
    db.with(|c| {
        c.execute(
            "UPDATE runs SET progress=?2, stage=?3, updated_at=?4 WHERE id=?1",
            params![run_id, progress, stage, now],
        )?;
        Ok(())
    })
}

/// Close a run with a terminal outcome (run-job-foundation D4): `done` carries
/// a `result_ref`, `error` carries error detail, `cancelled` carries neither.
pub fn set_terminal(
    db: &HistoryDb,
    run_id: &str,
    status: RunStatus,
    result_ref: Option<String>,
    error: Option<String>,
) -> Result<(), ApiError> {
    set_terminal_with_result(db, run_id, status, result_ref, error, None)
}

/// Close a run with a terminal outcome AND its immutable result snapshot
/// (stage-run-endpoints D1/D8). The snapshot is written once and not
/// overwritten by a later run (a re-run is a new row).
pub fn set_terminal_with_result(
    db: &HistoryDb,
    run_id: &str,
    status: RunStatus,
    result_ref: Option<String>,
    error: Option<String>,
    result_json: Option<&str>,
) -> Result<(), ApiError> {
    let now = now_unix();
    db.with(|c| {
        c.execute(
            "UPDATE runs SET status=?2, result_ref=?3, error=?4, result_json=?5, updated_at=?6 WHERE id=?1",
            params![run_id, status.as_str(), result_ref, error, result_json, now],
        )?;
        Ok(())
    })
}

fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<RunRecord> {
    let kind: String = row.get("kind")?;
    let status: String = row.get("status")?;
    let bad = |e: String| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
    };
    // A malformed snapshot must not poison the whole read — fall back to null.
    let result_json: Option<String> = row.get("result_json")?;
    let result = result_json.and_then(|s| serde_json::from_str(&s).ok());
    Ok(RunRecord {
        id: row.get("id")?,
        item_id: row.get("item_id")?,
        kind: RunKind::parse(&kind).map_err(bad)?,
        model: row.get("model")?,
        status: RunStatus::parse(&status).map_err(bad)?,
        progress: row.get("progress")?,
        stage: row.get("stage")?,
        result_ref: row.get("result_ref")?,
        error: row.get("error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        result,
        origin: RunOrigin::Stage,
    })
}

/// Fetch a single run by its id, or `None` if no such run exists.
pub fn get_by_id(db: &HistoryDb, run_id: &str) -> Result<Option<RunRecord>, ApiError> {
    db.with(|c| {
        c.query_row(
            &format!("{SELECT_COLS} WHERE id=?1"),
            params![run_id],
            row_to_record,
        )
        .optional()
    })
}

/// List every run recorded against an item, oldest first (append order). This
/// is the raw ledger read — the stage pipeline (diarize merge) relies on it
/// seeing ONLY real runs, so synthesis lives in `list_unified`, not here.
pub fn list_by_item(db: &HistoryDb, item_id: &str) -> Result<Vec<RunRecord>, ApiError> {
    db.with(|c| {
        let mut stmt = c.prepare(&format!(
            "{SELECT_COLS} WHERE item_id=?1 ORDER BY created_at, id"
        ))?;
        let rows = stmt.query_map(params![item_id], row_to_record)?;
        rows.collect()
    })
}

/// Normalize a possibly-millisecond timestamp to unix seconds — the clock the
/// runs ledger stamps with (`now_unix`). The frontend writes `Date.now()` (ms)
/// into `sessions.started_at` and `action_runs.ran_at`, so without this a
/// synthesized run would sort ~1000× later than every real run. Threshold 1e12
/// ≈ year 2001 in ms / year 33658 in s, so genuine second-stamps pass through.
fn to_unix_secs(ts: i64) -> i64 {
    if ts >= 1_000_000_000_000 {
        ts / 1000
    } else {
        ts
    }
}

/// Synthesize a read-only `capture`-origin transcribe run from a session's
/// captured finals (unify-run-ledger). `None` when the session has no finals.
/// The result snapshot mirrors a transcribe run's `{ segments: [...] }` shape
/// (`start` in seconds) so the detail view renders it like any transcript.
fn synth_capture_run(db: &HistoryDb, item_id: &str) -> Option<RunRecord> {
    let segs = crate::items::finals_segments(db, item_id);
    if segs.is_empty() {
        return None;
    }
    let started_at: Option<i64> = db
        .with(|c| {
            c.query_row(
                "SELECT started_at FROM sessions WHERE id = ?1",
                params![item_id],
                |r| r.get(0),
            )
            .optional()
        })
        .ok()
        .flatten();
    let created = started_at.map(to_unix_secs).unwrap_or(0);
    let segments: Vec<serde_json::Value> = segs
        .iter()
        .map(|(text, start_ms)| {
            serde_json::json!({
                "text": text,
                "start": start_ms.map(|ms| ms as f64 / 1000.0),
            })
        })
        .collect();
    Some(RunRecord {
        id: format!("capture:{item_id}"),
        item_id: item_id.to_owned(),
        kind: RunKind::Transcribe,
        model: None,
        status: RunStatus::Done,
        progress: 1.0,
        stage: None,
        result_ref: None,
        error: None,
        created_at: created,
        updated_at: created,
        result: Some(serde_json::json!({ "segments": segments })),
        origin: RunOrigin::Capture,
    })
}

/// Synthesize read-only `legacy`-origin `ai` runs from a session's v2
/// `action_runs` rows (unify-run-ledger), so historical AI Q&A appears in the
/// unified history alongside real `ai` runs. Best-effort: a read error yields
/// an empty list rather than failing the whole listing.
fn synth_legacy_ai_runs(db: &HistoryDb, item_id: &str) -> Vec<RunRecord> {
    db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT id, answer, ran_at FROM action_runs WHERE session_id = ?1 ORDER BY ran_at, id",
        )?;
        let rows = stmt.query_map(params![item_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .unwrap_or_default()
    .into_iter()
    .map(|(id, answer, ran_at)| {
        let created = to_unix_secs(ran_at);
        RunRecord {
            id: format!("legacy:{id}"),
            item_id: item_id.to_owned(),
            kind: RunKind::Ai,
            model: None,
            status: RunStatus::Done,
            progress: 1.0,
            stage: None,
            result_ref: None,
            error: None,
            created_at: created,
            updated_at: created,
            result: Some(serde_json::json!({ "answer": answer })),
            origin: RunOrigin::Legacy,
        }
    })
    .collect()
}

/// The unified item run history (unify-run-ledger): the real ledger runs plus
/// read-only runs synthesized from the session's capture finals and legacy
/// action_runs, sorted oldest-first. Synthesis is best-effort — it never turns
/// a successful ledger read into an error. The capture run is suppressed when a
/// real transcribe run already covers the transcript.
pub fn list_unified(db: &HistoryDb, item_id: &str) -> Result<Vec<RunRecord>, ApiError> {
    let mut runs = list_by_item(db, item_id)?;
    if !runs.iter().any(|r| r.kind == RunKind::Transcribe) {
        if let Some(cap) = synth_capture_run(db, item_id) {
            runs.push(cap);
        }
    }
    runs.extend(synth_legacy_ai_runs(db, item_id));
    runs.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    Ok(runs)
}

/// `GET /runs/{id}` (D5): the job-status contract for any run, served from the
/// persisted row — so it answers correctly after a restart, when no in-memory
/// job remains. An unknown id is a 404 with the standard error envelope.
#[utoipa::path(
    get,
    path = "/runs/{id}",
    tag = "items",
    params(("id" = String, Path, description = "Run id.")),
    responses(
        (status = 200, description = "The run's job-status contract plus result snapshot.", body = RunRecord),
        (status = 404, description = "No run with that id.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn get_run(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    match get_by_id(&state.history, &id) {
        Ok(Some(run)) => Json(run).into_response(),
        Ok(None) => ApiError::new(StatusCode::NOT_FOUND, "run not found").into_response(),
        Err(e) => e.into_response(),
    }
}

/// `GET /items/{id}/runs` — every run recorded against an item (oldest first),
/// each with its job-status contract + result snapshot. The run inspector
/// (fe-item-detail-runs) reads this to show the re-runnable pipeline history.
/// An item with no runs returns an empty list (not a 404).
#[utoipa::path(
    get,
    path = "/items/{id}/runs",
    tag = "items",
    params(("id" = String, Path, description = "Item id.")),
    responses(
        (status = 200, description = "All runs for the item (oldest first) as `{ \"runs\": RunRecord[] }`; an empty list when the item has no runs.", body = ItemRunsResponse),
        (status = 500, description = "History store error.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn list_item_runs(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    match list_unified(&state.history, &id) {
        Ok(runs) => Json(ItemRunsResponse { runs }).into_response(),
        Err(e) => e.into_response(),
    }
}

#[cfg(test)]
mod tests {
    //! Task 2.1: a `RunRecord` serializes to exactly the job-status contract.
    use super::*;
    use rusqlite::params;
    use std::path::PathBuf;

    fn test_db(name: &str) -> HistoryDb {
        let dir = std::env::temp_dir().join(format!("ww-runs-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmp");
        HistoryDb::open(&PathBuf::from(dir)).expect("open")
    }

    fn seed_session(db: &HistoryDb, id: &str, started_at: i64) {
        db.with(|c| {
            c.execute(
                "INSERT INTO sessions (id, started_at, mode) VALUES (?1, ?2, 'batch')",
                params![id, started_at],
            )
            .map(|_| ())
        })
        .expect("seed session");
    }

    fn seed_final(db: &HistoryDb, id: &str, ord: i64, text: &str, start_ms: Option<i64>) {
        db.with(|c| {
            c.execute(
                "INSERT INTO finals (session_id, ord, text, start_ms) VALUES (?1, ?2, ?3, ?4)",
                params![id, ord, text, start_ms],
            )
            .map(|_| ())
        })
        .expect("seed final");
    }

    #[test]
    fn synthesizes_capture_transcribe_run_from_finals() {
        // A batch quick-capture: finals exist, no transcribe run. The unified
        // listing surfaces a read-only `capture`-origin transcribe run first.
        let db = test_db("cap");
        seed_session(&db, "s1", 1_700_000_000_000); // ms (Date.now)
        seed_final(&db, "s1", 0, "第一句", Some(0));
        seed_final(&db, "s1", 1, "第二句", Some(2000));

        let runs = list_unified(&db, "s1").expect("list");
        assert_eq!(runs.len(), 1);
        let r = &runs[0];
        assert_eq!(r.kind, RunKind::Transcribe);
        assert_eq!(r.status, RunStatus::Done);
        assert_eq!(r.origin, RunOrigin::Capture);
        assert_eq!(r.id, "capture:s1");
        assert!(r.result_ref.is_none());
        // ms start time normalized to seconds so it sorts on the ledger clock.
        assert_eq!(r.created_at, 1_700_000_000);
        let segs = r.result.as_ref().unwrap()["segments"].as_array().unwrap();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0]["text"], "第一句");
        assert_eq!(segs[1]["start"], 2.0); // start_ms 2000 → 2.0 s
    }

    #[test]
    fn real_transcribe_run_suppresses_synthesized_capture() {
        // With a real transcribe run present, the finals row would be a dupe —
        // suppress it; the listing carries only `stage`-origin runs.
        let db = test_db("supp");
        seed_session(&db, "s1", 1_700_000_000_000);
        seed_final(&db, "s1", 0, "hi", Some(0));
        insert(
            &db,
            RunInsert {
                item_id: "s1".into(),
                kind: RunKind::Transcribe,
                model: None,
                params: None,
                status: RunStatus::Done,
                stage: None,
                progress: 1.0,
            },
        )
        .expect("insert transcribe run");

        let runs = list_unified(&db, "s1").expect("list");
        assert!(runs.iter().all(|r| r.origin == RunOrigin::Stage));
        assert!(!runs.iter().any(|r| r.id.starts_with("capture:")));
    }

    fn seed_action_run(db: &HistoryDb, session_id: &str, answer: &str, ran_at: i64) -> i64 {
        db.with(|c| {
            c.execute(
                "INSERT INTO action_runs (session_id, action_id, prompt, answer, ran_at) \
                 VALUES (?1, 'sum', 'p', ?2, ?3)",
                params![session_id, answer, ran_at],
            )
            .map(|_| ())?;
            c.query_row("SELECT last_insert_rowid()", [], |r| r.get::<_, i64>(0))
        })
        .expect("seed action_run")
    }

    fn insert_run(db: &HistoryDb, item_id: &str, kind: RunKind) -> String {
        insert(
            db,
            RunInsert {
                item_id: item_id.into(),
                kind,
                model: None,
                params: None,
                status: RunStatus::Done,
                stage: None,
                progress: 1.0,
            },
        )
        .expect("insert run")
    }

    #[test]
    fn synthesizes_legacy_ai_runs_and_interleaves_by_timestamp() {
        let db = test_db("legacy");
        seed_session(&db, "s1", 1_700_000_000_000);
        let aid = seed_action_run(&db, "s1", "the answer", 1_700_000_500_000); // ms, 2023
        let real_ai = insert_run(&db, "s1", RunKind::Ai); // real run, stamped ~now (2026+)

        let runs = list_unified(&db, "s1").expect("list");
        let ai: Vec<_> = runs.iter().filter(|r| r.kind == RunKind::Ai).collect();
        assert_eq!(ai.len(), 2);
        // Legacy (ran_at 2023) precedes the real run (stamped now).
        assert_eq!(ai[0].origin, RunOrigin::Legacy);
        assert_eq!(ai[0].id, format!("legacy:{aid}"));
        assert_eq!(ai[0].status, RunStatus::Done);
        assert_eq!(ai[0].result.as_ref().unwrap()["answer"], "the answer");
        assert_eq!(ai[0].created_at, 1_700_000_500); // ran_at ms → s
        assert_eq!(ai[1].origin, RunOrigin::Stage);
        assert_eq!(ai[1].id, real_ai);
    }

    #[test]
    fn legacy_lookup_failure_still_returns_real_runs() {
        // Synthesis is best-effort: a failed action_runs read must not turn a
        // successful ledger read into an error.
        let db = test_db("legacyfail");
        seed_session(&db, "s1", 1_700_000_000_000);
        let rid = insert_run(&db, "s1", RunKind::Transcribe);
        db.with(|c| c.execute("DROP TABLE action_runs", []).map(|_| ()))
            .expect("drop");

        let runs = list_unified(&db, "s1").expect("ledger read still succeeds");
        assert!(runs.iter().any(|r| r.id == rid));
    }

    #[test]
    fn run_record_serializes_to_contract_json() {
        let rec = RunRecord {
            id: "r1".into(),
            item_id: "i1".into(),
            kind: RunKind::Diarize,
            model: Some("fast".into()),
            status: RunStatus::Running,
            progress: 0.5,
            stage: Some("diarize".into()),
            result_ref: None,
            error: None,
            created_at: 100,
            updated_at: 200,
            result: None,
            origin: RunOrigin::Stage,
        };
        let v = serde_json::to_value(&rec).expect("serialize");

        assert_eq!(v["id"], "r1");
        assert_eq!(v["item_id"], "i1");
        assert_eq!(v["kind"], "diarize");
        assert_eq!(v["model"], "fast");
        assert_eq!(v["status"], "running");
        assert_eq!(v["progress"], 0.5);
        assert_eq!(v["stage"], "diarize");
        assert!(v["result_ref"].is_null());
        assert!(v["error"].is_null());
        assert_eq!(v["created_at"], 100);
        assert_eq!(v["updated_at"], 200);

        // `params` is storage-only — never surfaced in the status contract.
        let obj = v.as_object().expect("object");
        assert!(
            obj.get("params").is_none(),
            "params must not be in the contract"
        );
        // The additive `result` snapshot field (stage-run-endpoints D8) is
        // null when no snapshot.
        assert!(
            v["result"].is_null(),
            "result is null when there is no snapshot"
        );
        // A ledger-loaded run is always `stage` provenance (unify-run-ledger).
        assert_eq!(v["origin"], "stage");
        assert_eq!(
            obj.len(),
            13,
            "contract has exactly 13 keys, got {:?}",
            obj.keys().collect::<Vec<_>>()
        );
    }

    fn sample_record(id: &str) -> RunRecord {
        RunRecord {
            id: id.into(),
            item_id: "i1".into(),
            kind: RunKind::Transcribe,
            model: None,
            status: RunStatus::Done,
            progress: 1.0,
            stage: None,
            result_ref: None,
            error: None,
            created_at: 100,
            updated_at: 200,
            result: None,
            origin: RunOrigin::Stage,
        }
    }

    #[test]
    fn item_runs_response_serializes_to_wire_shape() {
        // Pin the `GET /items/{id}/runs` body byte-for-byte against the prior
        // `json!({ "runs": runs })`: a single `runs` key wrapping the array.
        let response = ItemRunsResponse {
            runs: vec![sample_record("r1"), sample_record("r2")],
        };
        let v = serde_json::to_value(&response).expect("serialize");
        assert_eq!(
            v,
            serde_json::json!({
                "runs": [
                    serde_json::to_value(sample_record("r1")).unwrap(),
                    serde_json::to_value(sample_record("r2")).unwrap(),
                ]
            })
        );
    }
}
