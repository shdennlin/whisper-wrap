//! Item-scoped stage endpoints (stage-run-endpoints).
//!
//! An "item" is heterogeneous: a `sessions` row or a `meeting_analyses` row,
//! each with its own `audio_path`. `resolve_audio` hides that two-table lookup
//! behind one seam (D2) so the stage handlers are item-kind-agnostic; stage
//! results live uniformly in the `runs` ledger's per-run snapshot.

use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use whisper_wrap_core::audio;

use crate::history::HistoryDb;
use crate::routes::ApiError;
use crate::runs::{self, RunInsert, RunKind, RunStatus};
use crate::state::AppState;

/// Resolve an item's stored audio across `sessions` then `meeting_analyses`.
/// No matching item -> 404; item present but with no stored audio -> 409.
/// Returns the stored `(audio_path, mime)`.
pub fn resolve_audio(db: &HistoryDb, id: &str) -> Result<(String, Option<String>), ApiError> {
    let row: Option<(Option<String>, Option<String>)> = db.with(|c| {
        let read = |sql: &str| {
            c.query_row(sql, params![id], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                ))
            })
            .optional()
        };
        let from_session = read("SELECT audio_path, audio_mime_type FROM sessions WHERE id = ?1")?;
        if from_session.is_some() {
            return Ok(from_session);
        }
        read("SELECT audio_path, audio_mime_type FROM meeting_analyses WHERE id = ?1")
    })?;

    let (path, mime) = row.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "item not found"))?;
    let path = path
        .filter(|p| !p.is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::CONFLICT, "item has no stored audio"))?;
    Ok((path, mime))
}

/// Decode an item's stored audio to samples, guarding that the stored path
/// canonicalizes inside the configured audio dir (defense in depth — the path
/// is server-managed, but a stored path is never trusted blindly).
async fn decode_item_audio(state: &Arc<AppState>, path: &str) -> Result<Vec<f32>, String> {
    let dir = std::fs::canonicalize(state.config.audio_dir())
        .map_err(|e| format!("audio dir unavailable: {e}"))?;
    let canon = std::fs::canonicalize(path).map_err(|e| format!("audio unreadable: {e}"))?;
    if !canon.starts_with(&dir) {
        return Err("stored audio path is outside the audio dir".into());
    }
    let timeout = state.config.upload_timeout_seconds;
    tokio::task::spawn_blocking(move || audio::decode_to_samples(&canon, timeout))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Open a run for a stage, return 202 with its id, and run `work` in a spawned
/// task. `work` yields the result-JSON snapshot (closed `done`) or an error
/// string (closed `error`). Shared by the transcribe / diarize / ai stages.
fn launch_run<F, Fut>(
    state: Arc<AppState>,
    item_id: String,
    kind: RunKind,
    model: Option<String>,
    stage: &'static str,
    work: F,
) -> Response
where
    F: FnOnce(Arc<AppState>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<serde_json::Value, String>> + Send,
{
    let run_id = match runs::insert(
        &state.history,
        RunInsert {
            item_id,
            kind,
            model,
            params: None,
            status: RunStatus::Running,
            stage: Some(stage.to_owned()),
            progress: 0.0,
        },
    ) {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };

    let st = Arc::clone(&state);
    let rid = run_id.clone();
    tokio::spawn(async move {
        match work(Arc::clone(&st)).await {
            Ok(v) => {
                let _ = runs::set_terminal_with_result(
                    &st.history,
                    &rid,
                    RunStatus::Done,
                    None,
                    None,
                    Some(&v.to_string()),
                );
            }
            Err(msg) => {
                let _ = runs::set_terminal(&st.history, &rid, RunStatus::Error, None, Some(msg));
            }
        }
    });

    (
        StatusCode::ACCEPTED,
        Json(json!({ "run_id": run_id, "status_url": format!("/runs/{run_id}") })),
    )
        .into_response()
}

#[derive(serde::Deserialize)]
pub struct ModelQuery {
    model: Option<String>,
}

/// `POST /items/{id}/transcribe?model=` — transcribe the item's stored audio on
/// the chosen model, snapshotting the transcript into a transcribe run (D3).
pub async fn items_transcribe(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<ModelQuery>,
) -> Response {
    let (audio_path, _mime) = match resolve_audio(&state.history, &id) {
        Ok(x) => x,
        Err(e) => return e.into_response(),
    };
    let model = q.model.clone();
    launch_run(
        Arc::clone(&state),
        id,
        RunKind::Transcribe,
        model.clone(),
        "asr",
        move |st| async move {
            let samples = decode_item_audio(&st, &audio_path).await?;
            let duration_seconds = samples.len() as f64 / 16000.0;
            // engine_for may load weights (blocking) on a cache miss.
            let st_eng = Arc::clone(&st);
            let m = model.clone();
            let engine = tokio::task::spawn_blocking(move || st_eng.engine_for(m.as_deref()))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.detail)?;
            let asr = tokio::task::spawn_blocking(move || {
                engine.transcribe_with_words(&samples, "auto", None, false)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
            Ok(json!({
                "language": asr.language,
                "duration_seconds": duration_seconds,
                "segments": asr.segments,
            }))
        },
    )
}

/// 404 unless the id matches a stored item (session or meeting). Used by the
/// AI stage, which gates on a transcript rather than on stored audio.
pub fn item_exists(db: &HistoryDb, id: &str) -> Result<(), ApiError> {
    let found: bool = db.with(|c| {
        let probe = |sql: &str| {
            c.query_row(sql, params![id], |r| r.get::<_, i64>(0))
                .optional()
        };
        if probe("SELECT 1 FROM sessions WHERE id = ?1")?.is_some() {
            return Ok(true);
        }
        Ok(probe("SELECT 1 FROM meeting_analyses WHERE id = ?1")?.is_some())
    })?;
    if found {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::NOT_FOUND, "item not found"))
    }
}

/// The newest completed transcribe run's segments for an item, if any — the
/// input to the diarize-merge and the AI stage's DAG gate.
/// The session's captured `finals` as ordered `(text, start_ms)` rows — the
/// shared primitive behind both the AI stage's transcript text and the
/// synthesized capture run (unify-run-ledger). Empty when the item has no
/// finals or on a read error.
pub(crate) fn finals_segments(db: &HistoryDb, item_id: &str) -> Vec<(String, Option<i64>)> {
    db.with(|c| {
        let mut stmt =
            c.prepare("SELECT text, start_ms FROM finals WHERE session_id = ?1 ORDER BY ord")?;
        let rows = stmt.query_map(params![item_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .unwrap_or_default()
}

/// Join the session's captured `finals` into one transcript string, ordered.
/// This is the AI stage's transcript source when no transcribe run exists yet
/// (quick captures persist finals, not runs).
fn finals_text(db: &HistoryDb, item_id: &str) -> Option<String> {
    let joined = finals_segments(db, item_id)
        .iter()
        .map(|(t, _)| t.as_str())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_owned();
    (!joined.is_empty()).then_some(joined)
}

fn latest_transcript_segments(
    db: &HistoryDb,
    item_id: &str,
) -> Option<Vec<whisper_wrap_core::asr::Segment>> {
    let rec = runs::list_by_item(db, item_id)
        .ok()?
        .into_iter()
        .rev()
        .find(|r| r.kind == RunKind::Transcribe && r.status == RunStatus::Done)?;
    serde_json::from_value(rec.result?.get("segments")?.clone()).ok()
}

/// The item's transcript text, from its latest transcribe run or, for a meeting
/// item, its stored analysis segments. `None` when the item has no transcript.
fn transcript_text(db: &HistoryDb, item_id: &str) -> Option<String> {
    let join = |texts: Vec<&str>| {
        let t = texts.join(" ").trim().to_owned();
        (!t.is_empty()).then_some(t)
    };
    if let Some(segs) = latest_transcript_segments(db, item_id) {
        if let Some(t) = join(segs.iter().map(|s| s.text.as_str()).collect()) {
            return Some(t);
        }
    }
    // Fall back to the session's captured finals. Quick captures (live or
    // batch) persist finals, not a transcribe run, so without this the AI
    // stage would 409 on a freshly captured item that already has a transcript.
    if let Some(t) = finals_text(db, item_id) {
        return Some(t);
    }
    // Meeting analysis transcript (segments stored in result_json).
    let result_json: Option<String> = db
        .with(|c| {
            c.query_row(
                "SELECT result_json FROM meeting_analyses WHERE id = ?1",
                params![item_id],
                |r| r.get(0),
            )
            .optional()
        })
        .ok()?;
    let value: serde_json::Value = serde_json::from_str(&result_json?).ok()?;
    let segs = value.get("segments")?.as_array()?;
    join(
        segs.iter()
            .filter_map(|s| s.get("text").and_then(|x| x.as_str()))
            .collect(),
    )
}

#[derive(serde::Deserialize)]
pub struct QualityQuery {
    quality: Option<String>,
}

/// `POST /items/{id}/diarize?quality=` — diarize the item's stored audio (D4).
/// When the item has a transcript the diarization is merged into
/// speaker-attributed segments; otherwise the raw speaker turns are recorded.
pub async fn items_diarize(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<QualityQuery>,
) -> Response {
    // Invalid quality is the caller's bug (400) regardless of the item.
    let tier = match crate::meeting::QualityTier::parse(q.quality.as_deref()) {
        Ok(t) => t,
        Err(reason) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "detail": { "error": "invalid_quality", "reason": reason } })),
            )
                .into_response()
        }
    };
    let (audio_path, _mime) = match resolve_audio(&state.history, &id) {
        Ok(x) => x,
        Err(e) => return e.into_response(),
    };
    let item_id = id.clone();
    launch_run(
        Arc::clone(&state),
        id,
        RunKind::Diarize,
        Some(tier.as_str().to_owned()),
        "diarize",
        move |st| async move {
            let samples = decode_item_audio(&st, &audio_path).await?;
            let st_d = Arc::clone(&st);
            let diarizer =
                tokio::task::spawn_blocking(move || crate::meeting::diarizer_for(&st_d, tier))
                    .await
                    .map_err(|e| e.to_string())??;
            let samples_for_diar = samples.clone();
            let turns =
                tokio::task::spawn_blocking(move || diarizer.diarize(&samples_for_diar, None))
                    .await
                    .map_err(|e| e.to_string())?
                    .map_err(|e| e.to_string())?;
            // Merge with the latest transcript when one exists, else raw turns.
            match latest_transcript_segments(&st.history, &item_id) {
                Some(segs) => {
                    let merged = whisper_wrap_core::diarize::assign_speakers(&segs, &turns);
                    Ok(json!({ "segments": merged, "quality": tier.as_str() }))
                }
                None => Ok(json!({ "speakers": turns, "quality": tier.as_str() })),
            }
        },
    )
}

#[derive(serde::Deserialize)]
pub struct AiBody {
    prompt: String,
}

/// `POST /items/{id}/ai?model=` — run a prompt over the item's transcript (D5).
/// Hard DAG gate: the item must exist (404) and have a transcript (409); the
/// LLM must be configured (503). `?model=` is recorded but does not switch the
/// LLM until llm-provider-abstraction.
pub async fn items_ai(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<ModelQuery>,
    Json(body): Json<AiBody>,
) -> Response {
    if let Err(e) = item_exists(&state.history, &id) {
        return e.into_response();
    }
    let transcript = match transcript_text(&state.history, &id) {
        Some(t) => t,
        None => {
            return (
                StatusCode::CONFLICT,
                Json(json!({ "detail": { "error": "missing_prerequisite", "reason": "item has no transcript; run transcribe first" } })),
            )
                .into_response()
        }
    };
    if !state.llm().configured() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "detail": "LLM not configured" })),
        )
            .into_response();
    }

    let prompt = body.prompt;
    launch_run(
        Arc::clone(&state),
        id,
        RunKind::Ai,
        q.model.clone(),
        "ai",
        move |st| async move {
            let input = format!("{prompt}\n\nTranscript:\n{transcript}");
            let answer = st.llm().ask(&input, None).await.map_err(|e| e.to_string())?;
            Ok(json!({ "answer": answer }))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ww-items-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmp");
        dir
    }

    fn db_with_session(name: &str, id: &str, audio_path: Option<&str>) -> HistoryDb {
        let db = HistoryDb::open(&tmp(name)).expect("open");
        db.with(|c| {
            c.execute(
                "INSERT INTO sessions (id, started_at, mode, audio_path) VALUES (?1, 1, 'batch', ?2)",
                params![id, audio_path],
            )
            .map(|_| ())
        })
        .expect("seed session");
        db
    }

    #[test]
    fn resolves_session_audio() {
        let db = db_with_session("ok", "s1", Some("/audio/s1.wav"));
        let (path, _mime) = resolve_audio(&db, "s1").expect("resolve");
        assert_eq!(path, "/audio/s1.wav");
    }

    #[test]
    fn unknown_item_is_404() {
        let db = HistoryDb::open(&tmp("missing")).expect("open");
        let err = resolve_audio(&db, "ghost").expect_err("unknown");
        assert_eq!(err.status, StatusCode::NOT_FOUND);
    }

    #[test]
    fn item_without_audio_is_409() {
        let db = db_with_session("noaudio", "s2", None);
        let err = resolve_audio(&db, "s2").expect_err("no audio");
        assert_eq!(err.status, StatusCode::CONFLICT);
    }

    fn seed_final(db: &HistoryDb, id: &str, ord: i64, text: &str) {
        db.with(|c| {
            c.execute(
                "INSERT INTO finals (session_id, ord, text) VALUES (?1, ?2, ?3)",
                params![id, ord, text],
            )
            .map(|_| ())
        })
        .expect("seed final");
    }

    #[test]
    fn transcript_text_falls_back_to_finals_when_no_run() {
        // A quick capture persists finals but no transcribe run; the AI stage
        // must still find a transcript.
        let db = db_with_session("finals", "s3", None);
        seed_final(&db, "s3", 0, "hello");
        seed_final(&db, "s3", 1, "world");
        assert_eq!(transcript_text(&db, "s3").as_deref(), Some("hello world"));
    }

    #[test]
    fn transcript_text_none_without_runs_or_finals() {
        let db = db_with_session("empty", "s4", None);
        assert_eq!(transcript_text(&db, "s4"), None);
    }
}
