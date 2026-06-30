//! Model management API — the v3 §12 requirement (v2 had `make`
//! targets only). GET /models lists registry entries + install
//! status; POST /models/active hot-swaps the running engine;
//! POST /models/download fetches a model's ggml weights from HF with
//! pollable progress (GET /models/download/{name}).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::Json;
use serde::Deserialize;
use serde_json::json;
use whisper_wrap_core::{registry, WhisperEngine};

use crate::routes::ApiError;
use crate::state::AppState;

/// Per-model download progress, keyed by model name. Survives for the
/// process lifetime so the PWA can poll after navigating away.
#[derive(Default)]
pub struct DownloadState {
    pub jobs: Mutex<HashMap<String, DownloadJob>>,
}

#[derive(Clone)]
pub struct DownloadJob {
    pub status: &'static str, // downloading | done | error | cancelled
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    /// Set by DELETE /models/download/{name}; the worker checks it between
    /// chunks. Only the worker flips `status` to "cancelled" — that ordering
    /// guarantees the .part file is gone before a re-download can start.
    pub cancel: Arc<AtomicBool>,
}

impl DownloadJob {
    pub(crate) fn started() -> Self {
        DownloadJob {
            status: "downloading",
            downloaded_bytes: 0,
            total_bytes: None,
            error: None,
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

pub async fn list(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>, ApiError> {
    let models = registry::list_models(&state.config).map_err(ApiError::internal)?;
    Ok(Json(json!({
        "active": state.model_snapshot().name,
        // The active *name* always resolves (lenient first-run boot), so the
        // UI needs to know whether weights are actually loaded to render
        // "Active" vs "Download"/"Load".
        "loaded": state.engine_handle().is_some(),
        "models": models,
    })))
}

#[derive(Deserialize)]
pub struct SwapRequest {
    name: String,
}

/// Hot-swap the active model. Mirrors `make set-model` semantics:
/// refuses (409) when the requested model is not downloaded.
/// Map a model-resolution failure to its HTTP status, shared by
/// `POST /models/active` and the per-request ASR selection path so the two
/// stay consistent: an unknown model is a 404; a registered model whose
/// weights / ggml variant / model dir are not usable is a 409; anything else
/// is a 500.
pub fn registry_error_status(e: &registry::RegistryError) -> ApiError {
    use whisper_wrap_core::registry::RegistryError as E;
    match e {
        E::UnknownModel(_) => ApiError::new(StatusCode::NOT_FOUND, e.to_string()),
        E::ModelFileMissing(_) | E::NoGgmlVariant(_) | E::EmptyModelDir(_) => {
            ApiError::new(StatusCode::CONFLICT, e.to_string())
        }
        _ => ApiError::internal(e),
    }
}

pub async fn set_active(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SwapRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Skip the reload only when this model is BOTH active AND already loaded.
    // On a fresh install the active model name matches the (lenient) default
    // but no engine is loaded yet — first-run must actually load it.
    let already_loaded = state.engine_handle().is_some();
    if already_loaded && req.name == state.model_snapshot().name {
        return Ok(Json(json!({"active": req.name, "swapped": false})));
    }

    let resolved = registry::resolve_named_model(&state.config, &req.name)
        .map_err(|e| registry_error_status(&e))?;

    log::info!(
        "hot-swapping model → {} ({})",
        resolved.name,
        resolved.bin_path.display()
    );
    let bin_path = resolved.bin_path.clone();
    let engine = tokio::task::spawn_blocking(move || WhisperEngine::load(&bin_path))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)?;
    let load_time_ms = engine.load_time_ms;

    *state.engine.write().expect("engine lock") = Some(Arc::new(engine));
    *state.model.write().expect("model lock") = resolved;

    Ok(Json(json!({
        "active": req.name,
        "swapped": true,
        "load_time_ms": load_time_ms,
    })))
}

#[derive(Deserialize)]
pub struct DownloadRequest {
    name: String,
}

/// Start (or report an already-running) download of a model's ggml
/// weights. Returns immediately; poll GET /models/download/{name}.
pub async fn download(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DownloadRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let spec = registry::ggml_download_spec(&state.config, &req.name).map_err(|e| {
        use whisper_wrap_core::registry::RegistryError as E;
        match &e {
            E::UnknownModel(_) | E::NoGgmlVariant(_) => {
                ApiError::new(StatusCode::NOT_FOUND, e.to_string())
            }
            _ => ApiError::internal(e),
        }
    })?;

    if spec.dest_file.is_file() {
        return Ok(Json(
            json!({"name": req.name, "status": "done", "already_present": true}),
        ));
    }

    {
        let mut jobs = state.downloads.jobs.lock().expect("dl lock");
        if let Some(j) = jobs.get(&req.name) {
            if j.status == "downloading" {
                return Ok(Json(json!({"name": req.name, "status": "downloading"})));
            }
        }
        jobs.insert(req.name.clone(), DownloadJob::started());
    }

    let st = Arc::clone(&state);
    let name = req.name.clone();
    tokio::task::spawn_blocking(move || run_download(st, name, spec));

    Ok(Json(json!({"name": req.name, "status": "downloading"})))
}

/// Outcome of the chunked copy loop.
pub(crate) enum CopyOutcome {
    Done(u64),
    Cancelled,
}

/// Chunked reader→writer copy that reports cumulative bytes after every
/// chunk and aborts when `cancel` flips. Extracted from the network path
/// so progress + cancellation are unit-testable.
pub(crate) fn copy_with_progress(
    mut reader: impl Read,
    mut writer: impl Write,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(u64),
) -> std::io::Result<CopyOutcome> {
    let mut buf = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(CopyOutcome::Cancelled);
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            return Ok(CopyOutcome::Done(total));
        }
        writer.write_all(&buf[..n])?;
        total += n as u64;
        on_progress(total);
    }
}

fn run_download(state: Arc<AppState>, name: String, spec: registry::DownloadSpec) {
    let set = |status: &'static str, err: Option<String>| {
        if let Some(j) = state.downloads.jobs.lock().expect("dl lock").get_mut(&name) {
            j.status = status;
            j.error = err;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&spec.dest_dir) {
        return set("error", Some(e.to_string()));
    }
    let remote = match &spec.subfolder {
        Some(sub) => format!("{sub}/{}", spec.filename),
        None => spec.filename.clone(),
    };

    // Cache-only lookup first (no network): weights already in the shared
    // HF cache (~/.cache/huggingface) copy over instantly.
    if let Some(cached) = hf_hub::Cache::default()
        .model(spec.repo_id.clone())
        .get(&remote)
    {
        if let Err(e) = std::fs::copy(&cached, &spec.dest_file) {
            return set("error", Some(format!("copy from HF cache failed: {e}")));
        }
        if let Ok(meta) = std::fs::metadata(&spec.dest_file) {
            if let Some(j) = state.downloads.jobs.lock().expect("dl lock").get_mut(&name) {
                j.downloaded_bytes = meta.len();
                j.total_bytes = Some(meta.len());
            }
        }
        log::info!(
            "model {name} copied from HF cache → {}",
            spec.dest_file.display()
        );
        return set("done", None);
    }

    // Cache miss → stream it ourselves so the job map gets live progress
    // and the cancel flag has somewhere to bite. hf-hub's sync `get()` is
    // one opaque blocking call — no per-chunk hook, no abort.
    let url = format!(
        "https://huggingface.co/{}/resolve/main/{remote}",
        spec.repo_id
    );
    let resp = match ureq::get(&url).call() {
        Ok(r) => r,
        Err(e) => return set("error", Some(format!("HF download failed: {e}"))),
    };
    let total: Option<u64> = resp.header("content-length").and_then(|v| v.parse().ok());
    if let Some(j) = state.downloads.jobs.lock().expect("dl lock").get_mut(&name) {
        j.total_bytes = total;
    }
    let cancel = match state.downloads.jobs.lock().expect("dl lock").get(&name) {
        Some(j) => Arc::clone(&j.cancel),
        None => return,
    };

    // Stream into a .part sibling; rename only on success so a killed or
    // cancelled download can never be mistaken for installed weights.
    let part = spec
        .dest_file
        .with_file_name(format!("{}.part", spec.filename));
    let outcome = (|| {
        let file = std::fs::File::create(&part)?;
        let mut writer = std::io::BufWriter::new(file);
        let out = copy_with_progress(resp.into_reader(), &mut writer, &cancel, |bytes| {
            if let Some(j) = state.downloads.jobs.lock().expect("dl lock").get_mut(&name) {
                j.downloaded_bytes = bytes;
            }
        })?;
        writer.flush()?;
        Ok::<CopyOutcome, std::io::Error>(out)
    })();

    match outcome {
        Ok(CopyOutcome::Done(bytes)) => {
            if let Err(e) = std::fs::rename(&part, &spec.dest_file) {
                let _ = std::fs::remove_file(&part);
                return set("error", Some(format!("finalize download failed: {e}")));
            }
            log::info!(
                "model {name} downloaded ({bytes} bytes) → {}",
                spec.dest_file.display()
            );
            set("done", None);
        }
        Ok(CopyOutcome::Cancelled) => {
            let _ = std::fs::remove_file(&part);
            log::info!("model {name} download cancelled");
            set("cancelled", None);
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            set("error", Some(format!("HF download failed: {e}")));
        }
    }
}

/// Request cancellation of an in-flight download. The worker notices the
/// flag between chunks, removes the partial file, then flips the job to
/// "cancelled" — poll GET /models/download/{name} to observe it land.
pub async fn cancel_download(
    State(state): State<Arc<AppState>>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let jobs = state.downloads.jobs.lock().expect("dl lock");
    match jobs.get(&name) {
        Some(j) if j.status == "downloading" => {
            j.cancel.store(true, Ordering::Relaxed);
            Ok(Json(json!({"name": name, "status": "cancelling"})))
        }
        Some(j) => Ok(Json(json!({"name": name, "status": j.status}))),
        None => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            format!("no download for {name}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_reports_cumulative_progress_and_finishes() {
        let data = vec![7u8; 200_000]; // > 3 chunks of 64 KiB
        let mut out = Vec::new();
        let cancel = AtomicBool::new(false);
        let mut seen = Vec::new();
        let outcome = copy_with_progress(&data[..], &mut out, &cancel, |b| seen.push(b)).unwrap();
        assert!(matches!(outcome, CopyOutcome::Done(200_000)));
        assert_eq!(out.len(), 200_000);
        assert_eq!(seen.last(), Some(&200_000));
        assert!(seen.len() >= 3, "expected per-chunk progress, got {seen:?}");
    }

    #[test]
    fn copy_aborts_when_cancel_flips_mid_stream() {
        let data = vec![7u8; 200_000];
        let mut out = Vec::new();
        let cancel = AtomicBool::new(false);
        let outcome = copy_with_progress(&data[..], &mut out, &cancel, |_| {
            cancel.store(true, Ordering::Relaxed); // flip after the first chunk
        })
        .unwrap();
        assert!(matches!(outcome, CopyOutcome::Cancelled));
        assert!(out.len() < 200_000, "must stop before draining the reader");
    }
}

/// Uninstall a model's on-disk weights (the "D" in model CRUD). Refuses to
/// remove the currently-loaded model — switch away first.
pub async fn delete_model(
    State(state): State<Arc<AppState>>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if state.engine_handle().is_some() && name == state.model_snapshot().name {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "cannot remove the active model; switch to another first",
        ));
    }
    let resolved = registry::resolve_named_model(&state.config, &name)
        .map_err(|e| registry_error_status(&e))?;
    let dir = resolved
        .bin_path
        .parent()
        .ok_or_else(|| ApiError::internal("model weight has no parent directory"))?;
    std::fs::remove_dir_all(dir).map_err(ApiError::internal)?;
    log::info!("removed model {name} → {}", dir.display());
    Ok(Json(json!({"name": name, "removed": true})))
}

pub async fn download_status(
    State(state): State<Arc<AppState>>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Installed-on-disk always wins, even across restarts (job map is
    // process-local).
    if registry::resolve_named_model(&state.config, &name).is_ok() {
        return Ok(Json(
            json!({"name": name, "status": "done", "installed": true}),
        ));
    }
    let jobs = state.downloads.jobs.lock().expect("dl lock");
    match jobs.get(&name) {
        Some(j) => Ok(Json(json!({
            "name": name,
            "status": j.status,
            "downloaded_bytes": j.downloaded_bytes,
            "total_bytes": j.total_bytes,
            "error": j.error,
        }))),
        None => Ok(Json(
            json!({"name": name, "status": "idle", "installed": false}),
        )),
    }
}

#[cfg(test)]
mod registry_status_tests {
    //! Task 1.1: the shared RegistryError -> HTTP mapping.
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn unknown_model_maps_to_404() {
        let e = registry::RegistryError::UnknownModel("ghost".into());
        assert_eq!(registry_error_status(&e).status, StatusCode::NOT_FOUND);
    }

    #[test]
    fn missing_weights_map_to_409() {
        let e = registry::RegistryError::ModelFileMissing(PathBuf::from("/nope/model.bin"));
        assert_eq!(registry_error_status(&e).status, StatusCode::CONFLICT);
    }
}
