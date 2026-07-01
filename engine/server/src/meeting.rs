//! POST /transcribe/meeting + GET/DELETE /transcribe/meeting/{id}.
//! Port of the v2 async-job meeting endpoint onto the all-Rust
//! pipeline: full-buffer ASR (whisper-rs) + sherpa diarization +
//! midpoint speaker assignment. Same job contract: 202 + job_id,
//! poll {status, progress, stage, result}, TTL+capacity eviction,
//! single-job concurrency, 503 availability gate.
// The early-return gates use an axum `Response` as the Err type (the natural
// "bail with this HTTP response" pattern); boxing it to satisfy
// result_large_err would only complicate every call site.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path as AxumPath, Query, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde_json::{json, Value};
use whisper_wrap_core::diarize::{assign_speakers, DiarizationBackend, SherpaCamPP};
use whisper_wrap_core::{audio, mime};

use crate::history;
use crate::runs;
use crate::state::AppState;

// ---------- run-ledger write-through (run-job-foundation, D4) ----------

/// Write an in-flight stage/progress update through to the durable run row.
/// A store failure is logged, never fatal — the in-memory job stays the live
/// source, so the meeting still completes for existing v2 clients.
fn run_progress(state: &AppState, run_id: &Option<String>, stage: &str, progress: f64) {
    if let Some(rid) = run_id {
        if let Err(e) = runs::update_progress(&state.history, rid, progress, stage) {
            log::warn!("run progress write failed for {rid}: {}", e.detail);
        }
    }
}

/// Close the run row at a terminal outcome (run-job-foundation D4): done carries
/// a result_ref, error carries detail, cancelled carries neither. `result_json`
/// is the diarize run's immutable analysis snapshot (stage-run-endpoints D7).
fn run_terminal(
    state: &AppState,
    run_id: &Option<String>,
    status: runs::RunStatus,
    result_ref: Option<String>,
    error: Option<String>,
    result_json: Option<&str>,
) {
    if let Some(rid) = run_id {
        if let Err(e) = runs::set_terminal_with_result(
            &state.history,
            rid,
            status,
            result_ref,
            error,
            result_json,
        ) {
            log::warn!("run terminal write failed for {rid}: {}", e.detail);
        }
    }
}

// ---------- job store ----------

#[derive(Clone)]
pub struct Job {
    pub status: &'static str, // pending | running | done | error | cancelled
    pub progress: f64,
    pub stage: String,
    pub result: Option<Value>,
    pub error: Option<(String, String)>, // (code, message)
    pub created: Instant,
    pub cancel_requested: bool,
}

/// Meeting diarization quality tier (the beta.4 dropdown). Fast = the
/// shipped CAM++ zh embedding; Balanced = a larger embedding model
/// (3D-Speaker ERes2NetV2) installed separately.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum QualityTier {
    Fast,
    Balanced,
}

impl QualityTier {
    pub(crate) fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw {
            None | Some("fast") => Ok(QualityTier::Fast),
            Some("balanced") => Ok(QualityTier::Balanced),
            Some(other) => Err(format!(
                "unknown quality {other:?} — expected fast|balanced"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            QualityTier::Fast => "fast",
            QualityTier::Balanced => "balanced",
        }
    }

    fn emb_model(self, c: &whisper_wrap_core::Config) -> &std::path::PathBuf {
        match self {
            QualityTier::Fast => &c.diarize_emb_model,
            QualityTier::Balanced => &c.diarize_emb_model_balanced,
        }
    }

    /// Tier to use when the caller OMITS `quality`: fast when its embedding is
    /// installed (the recommended default), else balanced when that's the only
    /// one present, else fast (so `availability_for` yields a sensible 503).
    /// Defense-in-depth so a balanced-only install isn't forced onto the
    /// missing fast default even if a client forgets to send `quality`.
    pub(crate) fn default_installed(c: &whisper_wrap_core::Config) -> Self {
        if c.diarize_emb_model.is_file() {
            QualityTier::Fast
        } else if c.diarize_emb_model_balanced.is_file() {
            QualityTier::Balanced
        } else {
            QualityTier::Fast
        }
    }
}

/// Tiers whose model files are installed — drives /status's
/// meeting.quality_tiers so the PWA can populate the dropdown.
pub fn available_tiers(c: &whisper_wrap_core::Config) -> Vec<&'static str> {
    if !c.diarize_seg_model.is_file() {
        return vec![];
    }
    [QualityTier::Fast, QualityTier::Balanced]
        .into_iter()
        .filter(|t| t.emb_model(c).is_file())
        .map(QualityTier::as_str)
        .collect()
}

/// Get-or-load the diarization backend for a tier from the process-lifetime
/// cache (lazy init, reused across calls). Shared by the meeting pipeline and
/// the item-scoped diarize stage (stage-run-endpoints).
pub(crate) fn diarizer_for(
    state: &AppState,
    tier: QualityTier,
) -> Result<Arc<dyn DiarizationBackend>, String> {
    let mut slots = state.meeting.diarizer.lock().expect("diarizer lock");
    if let Some(d) = slots.get(&tier) {
        return Ok(Arc::clone(d));
    }
    let d: Arc<dyn DiarizationBackend> = Arc::new(
        SherpaCamPP::new(
            &state.config.diarize_seg_model,
            tier.emb_model(&state.config),
        )
        .map_err(|e| e.to_string())?,
    );
    slots.insert(tier, Arc::clone(&d));
    Ok(d)
}

#[derive(Default)]
pub struct MeetingState {
    pub jobs: Mutex<HashMap<String, Job>>,
    pub pipeline: tokio::sync::Mutex<()>,
    pub diarizer: Mutex<HashMap<QualityTier, Arc<dyn DiarizationBackend>>>,
}

impl MeetingState {
    fn evict(&self, ttl: Duration, max_jobs: usize) {
        let mut jobs = self.jobs.lock().expect("jobs lock");
        jobs.retain(|_, j| j.created.elapsed() < ttl);
        if jobs.len() > max_jobs {
            let mut ids: Vec<(String, Instant)> =
                jobs.iter().map(|(k, j)| (k.clone(), j.created)).collect();
            ids.sort_by_key(|(_, t)| *t);
            let excess = jobs.len() - max_jobs;
            for (id, _) in ids.into_iter().take(excess) {
                jobs.remove(&id);
            }
        }
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut Job)) {
        if let Some(j) = self.jobs.lock().expect("jobs lock").get_mut(id) {
            f(j);
        }
    }

    fn cancel_requested(&self, id: &str) -> bool {
        self.jobs
            .lock()
            .expect("jobs lock")
            .get(id)
            .is_some_and(|j| j.cancel_requested)
    }
}

fn availability_for(state: &AppState, tier: QualityTier) -> Result<(), Response> {
    let c = &state.config;
    let emb = tier.emb_model(c);
    if !c.diarize_seg_model.is_file() || !emb.is_file() {
        let reason = format!(
            "diarization models missing for {} tier — expected {} and {}",
            tier.as_str(),
            c.diarize_seg_model.display(),
            emb.display()
        );
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"detail": {"error": "meeting_unavailable", "reason": reason}})),
        )
            .into_response());
    }
    Ok(())
}

/// Gate for endpoints that don't target a specific tier (status polling): the
/// meeting feature is available when segmentation + AT LEAST ONE embedding tier
/// is installed — the same definition /status reports (`available_tiers`
/// non-empty). The per-tier check lives in `availability_for` (used by submit),
/// which is what must be strict about which embedding a job actually needs.
fn availability(state: &AppState) -> Result<(), Response> {
    if !available_tiers(&state.config).is_empty() {
        return Ok(());
    }
    Err((
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"detail": {
            "error": "meeting_unavailable",
            "reason": "diarization models not installed"
        }})),
    )
        .into_response())
}

// ---------- typed success bodies ----------
// These type ONLY the success payloads. The error paths keep their ad-hoc
// `{detail: {error, reason}}` object shape (see design.md failure-modes note)
// and are intentionally left as `json!()` values.

/// 202 job descriptor returned by `POST /transcribe/meeting`.
#[derive(serde::Serialize, utoipa::ToSchema)]
pub struct SubmitResponse {
    /// Opaque job id — poll `status_url` for progress.
    job_id: String,
    /// Relative URL of the poll endpoint for this job.
    status_url: String,
}

/// Terminal-error detail spliced into a poll response only when the job
/// failed. Omitted entirely for pending/running/done/cancelled jobs.
#[derive(serde::Serialize, utoipa::ToSchema)]
pub struct PollError {
    /// Machine-readable error code (e.g. `asr_failed`, `diarize_failed`).
    code: String,
    /// Human-readable failure message.
    message: String,
}

/// Job-status body returned by `GET /transcribe/meeting/{id}`. `result` is the
/// per-kind analysis snapshot — `null` until the job is `done` — and is always
/// present. `error` is present only for a failed job.
#[derive(serde::Serialize, utoipa::ToSchema)]
pub struct PollResponse {
    /// pending | running | done | error | cancelled.
    status: String,
    /// Fractional progress in `[0, 1]`.
    progress: f64,
    /// Current pipeline stage (asr | diarize | complete | failed | …).
    stage: String,
    /// Analysis result once `done`, otherwise `null` (always present).
    result: Option<Value>,
    /// Present only when `status == "error"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<PollError>,
}

/// 202 acknowledgement returned by `DELETE /transcribe/meeting/{id}`.
#[derive(serde::Serialize, utoipa::ToSchema)]
pub struct CancelResponse {
    /// Id of the job whose cancellation was requested.
    job_id: String,
    /// Always `"cancel_requested"`.
    status: String,
    /// Advisory note about cancellation latency.
    note: String,
}

// ---------- endpoints ----------

/// Query params on POST /transcribe/meeting. The PWA uploads the raw
/// file body and passes the original name here (a raw body has no
/// filename of its own). The v2 endpoint also accepted language /
/// speaker-count / word-timestamp tuning params — serde ignores
/// unknown query keys, so those continue to be accepted (and, as in
/// the Fast tier, ignored) rather than rejected.
#[derive(serde::Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SubmitQuery {
    filename: Option<String>,
    /// fast (default) | balanced — diarization quality tier.
    quality: Option<String>,
    /// Optional per-request ASR model (stage-run-endpoints D7). Absent selects
    /// the active engine — the v2 behavior.
    model: Option<String>,
}

#[utoipa::path(
    post,
    path = "/transcribe/meeting",
    tag = "transcription",
    params(SubmitQuery),
    request_body(
        content_type = "multipart/form-data",
        description = "Multipart upload with a `file` part carrying the meeting \
            audio. Query params select the filename, diarization quality tier \
            (`fast`|`balanced`), and optional per-request ASR model.",
        content = Vec<u8>
    ),
    responses(
        (status = 202, description = "Job accepted — returns a job descriptor; poll `GET /transcribe/meeting/{id}` for progress.", body = SubmitResponse),
        (status = 400, description = "Invalid quality tier or malformed upload (ad-hoc `{detail:{error,reason}}` body)."),
        (status = 413, description = "Audio exceeds the configured maximum file size."),
        (status = 415, description = "Unsupported Content-Type or media format.")
    )
)]
pub async fn submit(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SubmitQuery>,
    req: Request,
) -> Response {
    // Input validation before the availability gate: a typo'd quality is
    // the caller's bug (400) regardless of which models are installed. An
    // OMITTED quality resolves to an installed tier (defense-in-depth): the
    // PWA normally sends the right tier, but a balanced-only install must not
    // be forced onto the missing fast default.
    let tier = match q.quality.as_deref() {
        None => QualityTier::default_installed(&state.config),
        Some(raw) => match QualityTier::parse(Some(raw)) {
            Ok(t) => t,
            Err(reason) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"detail": {"error": "invalid_quality", "reason": reason}})),
                )
                    .into_response()
            }
        },
    };
    if let Err(resp) = availability_for(&state, tier) {
        return resp;
    }
    state.meeting.evict(
        Duration::from_secs(state.config.meeting_job_ttl_seconds),
        state.config.meeting_max_jobs,
    );

    // Mirror /transcribe's dispatch (v2 contract): multipart form,
    // raw audio/* body, or application/octet-stream. The PWA uses the
    // raw-body path — multipart-only parsing 400s on it.
    let content_type = crate::routes::normalize_content_type(
        req.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
    );
    if !crate::routes::is_supported_dispatch_type(&content_type) {
        let shown = if content_type.is_empty() {
            "<missing>"
        } else {
            &content_type
        };
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Json(json!({"detail": format!("Unsupported Content-Type: {shown}")})),
        )
            .into_response();
    }
    let (body, suffix, upload_name) = if content_type == "multipart/form-data" {
        match read_named_file(req).await {
            Ok(x) => x,
            Err(e) => return e.into_response(),
        }
    } else {
        match axum::body::to_bytes(req.into_body(), usize::MAX).await {
            Ok(bytes) => (
                bytes.to_vec(),
                crate::routes::raw_body_suffix(&content_type).to_owned(),
                String::new(),
            ),
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"detail": e.to_string()})),
                )
                    .into_response()
            }
        }
    };
    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"detail": "Empty audio body"})),
        )
            .into_response();
    }
    if body.len() as u64 > state.config.max_file_size_bytes() {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({"detail": format!("File too large. Maximum size: {}MB", state.config.max_file_size_mb)})),
        )
            .into_response();
    }

    let job_id = ulid::Ulid::new().to_string();
    // History display name (v2 precedence): explicit ?filename= wins,
    // then the multipart upload's own name, then a synthesised label.
    let filename = q
        .filename
        .filter(|s| !s.trim().is_empty())
        .or_else(|| (!upload_name.is_empty()).then_some(upload_name))
        .unwrap_or_else(|| format!("meeting-{job_id}"));
    state.meeting.jobs.lock().expect("jobs lock").insert(
        job_id.clone(),
        Job {
            status: "pending",
            progress: 0.0,
            stage: "queued".into(),
            result: None,
            error: None,
            created: Instant::now(),
            cancel_requested: false,
        },
    );

    // Open the durable run mirror (D4): the diarize run for this item starts
    // running at submit; the pipeline writes progress through and closes it.
    // A store failure must not block the meeting (the in-memory job remains the
    // live source), so we log and proceed without a run id.
    let run_id = match runs::insert(
        &state.history,
        runs::RunInsert {
            item_id: job_id.clone(),
            kind: runs::RunKind::Diarize,
            model: Some(tier.as_str().to_owned()),
            params: None,
            status: runs::RunStatus::Running,
            stage: Some("queued".into()),
            progress: 0.0,
        },
    ) {
        Ok(rid) => Some(rid),
        Err(e) => {
            log::warn!("run insert failed for meeting {job_id}: {}", e.detail);
            None
        }
    };

    let st = Arc::clone(&state);
    let id = job_id.clone();
    let model = q.model.clone();
    tokio::spawn(async move {
        run_pipeline(st, id, run_id, body, suffix, filename, tier, model).await;
    });

    (
        StatusCode::ACCEPTED,
        Json(SubmitResponse {
            status_url: format!("/transcribe/meeting/{job_id}"),
            job_id,
        }),
    )
        .into_response()
}

#[utoipa::path(
    get,
    path = "/transcribe/meeting/{id}",
    tag = "transcription",
    params(("id" = String, Path, description = "Meeting job id returned by the submit call.")),
    responses(
        (status = 200, description = "Current job status and, when finished, the result.", body = PollResponse),
        (status = 404, description = "No job with that id.")
    )
)]
pub async fn poll(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    if let Err(resp) = availability(&state) {
        return resp;
    }
    state.meeting.evict(
        Duration::from_secs(state.config.meeting_job_ttl_seconds),
        state.config.meeting_max_jobs,
    );
    let jobs = state.meeting.jobs.lock().expect("jobs lock");
    let Some(job) = jobs.get(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"detail": {"error": "job_not_found"}})),
        )
            .into_response();
    };
    let payload = PollResponse {
        status: job.status.to_string(),
        progress: job.progress,
        stage: job.stage.clone(),
        result: job.result.clone(),
        error: job.error.as_ref().map(|(code, message)| PollError {
            code: code.clone(),
            message: message.clone(),
        }),
    };
    Json(payload).into_response()
}

#[utoipa::path(
    delete,
    path = "/transcribe/meeting/{id}",
    tag = "transcription",
    params(("id" = String, Path, description = "Meeting job id to cancel.")),
    responses(
        (status = 202, description = "Cancellation requested for an in-flight job.", body = CancelResponse),
        (status = 404, description = "No job with that id."),
        (status = 409, description = "Job already finished (done/error/cancelled).")
    )
)]
pub async fn cancel(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let mut jobs = state.meeting.jobs.lock().expect("jobs lock");
    let Some(job) = jobs.get_mut(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"detail": {"error": "job_not_found"}})),
        )
            .into_response();
    };
    if matches!(job.status, "done" | "error" | "cancelled") {
        return (
            StatusCode::CONFLICT,
            Json(json!({"detail": {"error": "job_finished"}})),
        )
            .into_response();
    }
    job.cancel_requested = true;
    (
        StatusCode::ACCEPTED,
        Json(CancelResponse {
            job_id: id,
            status: "cancel_requested".to_string(),
            note: "actual cancellation may take up to one pipeline stage to take effect".to_string(),
        }),
    )
        .into_response()
}

// ---------- pipeline ----------

#[allow(clippy::too_many_arguments)]
async fn run_pipeline(
    state: Arc<AppState>,
    id: String,
    run_id: Option<String>,
    body: Vec<u8>,
    suffix: String,
    filename: String,
    tier: QualityTier,
    model: Option<String>,
) {
    // Single-job concurrency: second job stays pending while the
    // first runs (v2 behaviour).
    let _guard = state.meeting.pipeline.lock().await;
    if state.meeting.cancel_requested(&id) {
        state.meeting.update(&id, |j| {
            j.status = "cancelled";
            j.stage = "cancelled".into();
        });
        run_terminal(
            &state,
            &run_id,
            runs::RunStatus::Cancelled,
            None,
            None,
            None,
        );
        return;
    }
    // Stage strings are CONTRACT: the PWA stepper matches them by
    // exact string (v2 set: asr / align / diarize / complete). A
    // misspelled stage leaves the stepper stuck on the previous step.
    state.meeting.update(&id, |j| {
        j.status = "running";
        j.stage = "asr".into();
        j.progress = 0.05;
    });
    run_progress(&state, &run_id, "asr", 0.05);

    let result = pipeline_inner(&state, &id, &run_id, body, suffix, tier, model).await;
    match result {
        Ok(value) => {
            // Auto-persist (v2 behaviour): the row lands in history
            // without a client roundtrip, so the PWA sidebar survives
            // job-store eviction and restarts.
            let m = history::MeetingCreate {
                id: id.clone(),
                filename,
                created_at: None,
                duration_seconds: value["duration_seconds"].as_f64(),
                language: value["language"].as_str().map(str::to_owned),
                speakers_count: value["speakers"].as_array().map(|a| a.len() as i64),
                speaker_names: serde_json::json!({}),
                status: "done".into(),
                result: value.clone(),
            };
            if let Err(e) = history::insert_meeting(&state.history, &m) {
                log::warn!("meeting auto-persist failed: {}", e.detail);
            }
            // The diarize run snapshots the merged analysis (D7): result_ref
            // still points at the persisted meeting_analyses row (D3), and
            // result_json carries the immutable, switchable version.
            let snapshot = value.to_string();
            state.meeting.update(&id, |j| {
                j.status = "done";
                j.stage = "complete".into();
                j.progress = 1.0;
                j.result = Some(value);
            });
            run_terminal(
                &state,
                &run_id,
                runs::RunStatus::Done,
                Some(id.clone()),
                None,
                Some(&snapshot),
            );
        }
        Err((code, message)) => {
            let cancelled = code == "cancelled";
            state.meeting.update(&id, |j| {
                j.status = if cancelled { "cancelled" } else { "error" };
                j.stage = if cancelled {
                    "cancelled".into()
                } else {
                    "failed".into()
                };
                j.error = Some((code, message.clone()));
            });
            if cancelled {
                run_terminal(
                    &state,
                    &run_id,
                    runs::RunStatus::Cancelled,
                    None,
                    None,
                    None,
                );
            } else {
                run_terminal(
                    &state,
                    &run_id,
                    runs::RunStatus::Error,
                    None,
                    Some(message),
                    None,
                );
            }
        }
    }
}

async fn pipeline_inner(
    state: &Arc<AppState>,
    id: &str,
    run_id: &Option<String>,
    body: Vec<u8>,
    suffix: String,
    tier: QualityTier,
    model: Option<String>,
) -> Result<Value, (String, String)> {
    let fail = |code: &str, msg: String| (code.to_owned(), msg);

    // Stage: decode
    let temp = state
        .config
        .temp_dir
        .join(format!("{}{}", uuid::Uuid::new_v4(), suffix));
    std::fs::write(&temp, &body).map_err(|e| fail("pipeline_failed", e.to_string()))?;
    let detected = mime::detect_mime(&temp).unwrap_or_default();
    if !mime::is_supported_av(&detected) {
        let _ = std::fs::remove_file(&temp);
        return Err(fail(
            "pipeline_failed",
            format!("Unsupported file format. Detected: {detected}"),
        ));
    }
    let samples = {
        let t = temp.clone();
        // Long files: generous decode timeout (10 min audio ≈ seconds to decode).
        tokio::task::spawn_blocking(move || audio::decode_to_samples(&t, 300))
            .await
            .map_err(|e| fail("pipeline_failed", e.to_string()))?
            .map_err(|e| fail("pipeline_failed", e.to_string()))?
    };
    let _ = std::fs::remove_file(&temp);
    let duration_seconds = samples.len() as f64 / 16000.0;

    if state.meeting.cancel_requested(id) {
        return Err(fail("cancelled", "cancelled between stages".into()));
    }
    state.meeting.update(id, |j| {
        j.stage = "asr".into();
        j.progress = 0.15;
    });
    run_progress(state, run_id, "asr", 0.15);

    // Stage: ASR (full buffer) — word timestamps on, so the meeting
    // view gets per-word click-to-seek (v2 parity; here via
    // whisper.cpp heuristic token times instead of wav2vec2). The model is
    // selected per request via engine_for (D7); absent = the active engine.
    let engine = {
        let st = Arc::clone(state);
        let m = model.clone();
        tokio::task::spawn_blocking(move || st.engine_for(m.as_deref()))
            .await
            .map_err(|e| fail("asr_failed", e.to_string()))?
            .map_err(|e| {
                let code = if e.status == StatusCode::SERVICE_UNAVAILABLE {
                    "no_model"
                } else {
                    "asr_failed"
                };
                fail(code, e.detail)
            })?
    };
    let asr_samples = samples.clone();
    let asr = tokio::task::spawn_blocking(move || {
        engine.transcribe_with_words(&asr_samples, "auto", None, false)
    })
    .await
    .map_err(|e| fail("asr_failed", e.to_string()))?
    .map_err(|e| fail("asr_failed", e.to_string()))?;

    if state.meeting.cancel_requested(id) {
        return Err(fail("cancelled", "cancelled between stages".into()));
    }
    state.meeting.update(id, |j| {
        j.stage = "diarize".into();
        j.progress = 0.55;
    });
    run_progress(state, run_id, "diarize", 0.55);

    // Stage: diarization — the per-tier backend cache, shared with the
    // item-scoped diarize stage (stage-run-endpoints D4).
    let diarizer = diarizer_for(state, tier).map_err(|e| fail("diarize_failed", e))?;
    let diar = tokio::task::spawn_blocking(move || diarizer.diarize(&samples, None))
        .await
        .map_err(|e| fail("diarize_failed", e.to_string()))?
        .map_err(|e| fail("diarize_failed", e.to_string()))?;

    state.meeting.update(id, |j| {
        // No separate v2 stage for the merge — it's sub-second; keep
        // reporting "diarize" so the stepper string-match holds.
        j.stage = "diarize".into();
        j.progress = 0.9;
    });
    run_progress(state, run_id, "diarize", 0.9);

    // Stage: merge
    let segments = assign_speakers(&asr.segments, &diar);
    let mut speakers: Vec<String> = segments.iter().map(|s| s.speaker.clone()).collect();
    speakers.sort();
    speakers.dedup();

    Ok(json!({
        "language": asr.language,
        "duration_seconds": duration_seconds,
        "speakers": speakers,
        "segments": segments,
        // Which diarization tier produced this — lets the maintainer A/B
        // fast vs balanced on the same recording from history alone.
        "quality": tier.as_str(),
    }))
}

async fn read_named_file(
    req: Request,
) -> Result<(Vec<u8>, String, String), crate::routes::ApiError> {
    use crate::routes::ApiError;
    use axum::extract::{FromRequest, Multipart};
    let mut multipart = Multipart::from_request(req, &())
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?
    {
        if field.name() == Some("file") {
            let filename = field.file_name().unwrap_or("audio.unknown").to_owned();
            let suffix = std::path::Path::new(&filename)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_else(|| ".audio".into());
            let bytes = field
                .bytes()
                .await
                .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
            return Ok((bytes.to_vec(), suffix, filename));
        }
    }
    Err(ApiError::new(
        StatusCode::BAD_REQUEST,
        "Missing form field 'file'",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Wire-shape guards: each typed success body must serialize byte-identically
    // to the pre-typing `json!()` payload the handler produced before.

    #[test]
    fn submit_response_wire_shape() {
        let resp = SubmitResponse {
            job_id: "job123".to_string(),
            status_url: "/transcribe/meeting/job123".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&resp).unwrap(),
            json!({"job_id": "job123", "status_url": "/transcribe/meeting/job123"})
        );
    }

    // Poll WITHOUT the optional `error` field: the key must be omitted entirely,
    // while `result` stays present as `null`.
    #[test]
    fn poll_response_omits_error_when_absent() {
        let resp = PollResponse {
            status: "running".to_string(),
            progress: 0.55,
            stage: "diarize".to_string(),
            result: None,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&resp).unwrap(),
            json!({
                "status": "running",
                "progress": 0.55,
                "stage": "diarize",
                "result": null
            })
        );
    }

    // Poll WITH the optional `error` field (and a populated `result`): the
    // spliced-in `{code, message}` object must match today's shape exactly.
    #[test]
    fn poll_response_includes_error_when_present() {
        let resp = PollResponse {
            status: "error".to_string(),
            progress: 1.0,
            stage: "failed".to_string(),
            result: Some(json!({"language": "en"})),
            error: Some(PollError {
                code: "asr_failed".to_string(),
                message: "boom".to_string(),
            }),
        };
        assert_eq!(
            serde_json::to_value(&resp).unwrap(),
            json!({
                "status": "error",
                "progress": 1.0,
                "stage": "failed",
                "result": {"language": "en"},
                "error": {"code": "asr_failed", "message": "boom"}
            })
        );
    }

    #[test]
    fn cancel_response_wire_shape() {
        let resp = CancelResponse {
            job_id: "job123".to_string(),
            status: "cancel_requested".to_string(),
            note: "actual cancellation may take up to one pipeline stage to take effect".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&resp).unwrap(),
            json!({
                "job_id": "job123",
                "status": "cancel_requested",
                "note": "actual cancellation may take up to one pipeline stage to take effect"
            })
        );
    }
}
