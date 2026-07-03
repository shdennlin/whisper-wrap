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
use serde::{Deserialize, Serialize};
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

/// Schema mirror of [`registry::ModelListing`] (core crate: derives
/// `Serialize` but not `ToSchema`). It is referenced only via `value_type` for
/// the OpenAPI schema of the `models` array — the wire value is the real
/// `ModelListing`, whose snake_case keys and null-for-`None` optionals this
/// mirrors byte-for-byte, so serialization is unchanged.
#[derive(Serialize, utoipa::ToSchema)]
struct ModelEntry {
    name: String,
    description: Option<String>,
    license: Option<String>,
    size: Option<String>,
    languages: Vec<String>,
    recommended: bool,
    speed: Option<f64>,
    accuracy: Option<f64>,
    tags: Vec<String>,
    formats: Vec<String>,
    installed: bool,
    runnable: bool,
}

/// `GET /models` success body: the active model name, whether its weights are
/// actually loaded, and the registry listing.
#[derive(Serialize, utoipa::ToSchema)]
pub struct ModelsListResponse {
    active: String,
    loaded: bool,
    #[schema(value_type = Vec<ModelEntry>)]
    models: Vec<registry::ModelListing>,
}

#[utoipa::path(
    get,
    path = "/models",
    tag = "models",
    responses(
        (status = 200, description = "Installed + registered ASR models with active/loaded state.", body = ModelsListResponse),
        (status = 500, description = "Registry read error.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn list(State(state): State<Arc<AppState>>) -> Result<Json<ModelsListResponse>, ApiError> {
    let models = registry::list_models(&state.config).map_err(ApiError::internal)?;
    Ok(Json(ModelsListResponse {
        active: state.model_snapshot().name,
        // The active *name* always resolves (lenient first-run boot), so the
        // UI needs to know whether weights are actually loaded to render
        // "Active" vs "Download"/"Load".
        loaded: state.engine_handle().is_some(),
        models,
    }))
}

#[derive(Deserialize, utoipa::ToSchema)]
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

/// `POST /models/active` success body. `load_time_ms` is present **only** when
/// a load actually happened (`swapped = true`); it is omitted on the no-op path
/// (`swapped = false`, the model was already active and loaded). The key is
/// snake_case on the wire, matching the prior ad-hoc JSON.
#[derive(Serialize, utoipa::ToSchema)]
pub struct SetActiveResponse {
    active: String,
    swapped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    load_time_ms: Option<u128>,
}

#[utoipa::path(
    post,
    path = "/models/active",
    tag = "models",
    request_body(content = SwapRequest, description = "The model name to load as the active engine."),
    responses(
        (status = 200, description = "Model activated (or a no-op when already active + loaded).", body = SetActiveResponse),
        (status = 404, description = "Unknown model name.", body = crate::routes::ApiErrorBody),
        (status = 409, description = "Model weights missing or unusable.", body = crate::routes::ApiErrorBody),
        (status = 500, description = "Load failure.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn set_active(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SwapRequest>,
) -> Result<Json<SetActiveResponse>, ApiError> {
    // Skip the reload only when this model is BOTH active AND already loaded.
    // On a fresh install the active model name matches the (lenient) default
    // but no engine is loaded yet — first-run must actually load it.
    let already_loaded = state.engine_handle().is_some();
    if already_loaded && req.name == state.model_snapshot().name {
        return Ok(Json(SetActiveResponse {
            active: req.name,
            swapped: false,
            load_time_ms: None,
        }));
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

    Ok(Json(SetActiveResponse {
        active: req.name,
        swapped: true,
        load_time_ms: Some(load_time_ms),
    }))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct DownloadRequest {
    name: String,
}

/// `POST /models/download` success body. Two states share the `name` + `status`
/// discriminant: a `status = "done"` response carries `already_present: true`
/// (weights already on disk, nothing queued); a `status = "downloading"`
/// response omits `already_present`. `already_present` is emitted **only** in
/// the done state, exactly as the prior ad-hoc JSON did.
#[derive(Serialize, utoipa::ToSchema)]
pub struct DownloadResponse {
    name: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    already_present: Option<bool>,
}

/// Start (or report an already-running) download of a model's ggml
/// weights. Returns immediately; poll GET /models/download/{name}.
#[utoipa::path(
    post,
    path = "/models/download",
    tag = "models",
    request_body(content = DownloadRequest, description = "The model name to download."),
    responses(
        (status = 200, description = "Download started/queued, or already present. `status = \"done\"` adds `already_present: true`; `status = \"downloading\"` omits it.", body = DownloadResponse),
        (status = 404, description = "Unknown model name.", body = crate::routes::ApiErrorBody),
        (status = 409, description = "A download for this model is already in progress.", body = crate::routes::ApiErrorBody),
        (status = 500, description = "Download setup failure.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn download(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DownloadRequest>,
) -> Result<Json<DownloadResponse>, ApiError> {
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
        return Ok(Json(DownloadResponse {
            name: req.name.clone(),
            status: "done".to_string(),
            already_present: Some(true),
        }));
    }

    {
        let mut jobs = state.downloads.jobs.lock().expect("dl lock");
        if let Some(j) = jobs.get(&req.name) {
            if j.status == "downloading" {
                return Ok(Json(DownloadResponse {
                    name: req.name.clone(),
                    status: "downloading".to_string(),
                    already_present: None,
                }));
            }
        }
        jobs.insert(req.name.clone(), DownloadJob::started());
    }

    let st = Arc::clone(&state);
    let name = req.name.clone();
    tokio::task::spawn_blocking(move || run_download(st, name, spec));

    Ok(Json(DownloadResponse {
        name: req.name,
        status: "downloading".to_string(),
        already_present: None,
    }))
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

/// `DELETE /models/download/{name}` acknowledgement: the model name and the
/// resulting download `status` — `"cancelling"` when a live download was asked
/// to stop, otherwise the job's current (terminal) status.
#[derive(Serialize, utoipa::ToSchema)]
pub struct CancelDownloadResponse {
    name: String,
    status: String,
}

/// Request cancellation of an in-flight download. The worker notices the
/// flag between chunks, removes the partial file, then flips the job to
/// "cancelled" — poll GET /models/download/{name} to observe it land.
#[utoipa::path(
    delete,
    path = "/models/download/{name}",
    tag = "models",
    params(("name" = String, Path, description = "Model name whose download to cancel.")),
    responses(
        (status = 200, description = "Download cancellation acknowledged.", body = CancelDownloadResponse),
        (status = 404, description = "No active download for that model.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn cancel_download(
    State(state): State<Arc<AppState>>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<CancelDownloadResponse>, ApiError> {
    let jobs = state.downloads.jobs.lock().expect("dl lock");
    match jobs.get(&name) {
        Some(j) if j.status == "downloading" => {
            j.cancel.store(true, Ordering::Relaxed);
            Ok(Json(CancelDownloadResponse {
                name: name.clone(),
                status: "cancelling".to_string(),
            }))
        }
        Some(j) => Ok(Json(CancelDownloadResponse {
            name: name.clone(),
            status: j.status.to_string(),
        })),
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

/// `DELETE /models/{name}` acknowledgement: the removed model name and a
/// constant `removed: true` flag.
#[derive(Serialize, utoipa::ToSchema)]
pub struct DeleteModelResponse {
    name: String,
    removed: bool,
}

/// Uninstall a model's on-disk weights (the "D" in model CRUD). Refuses to
/// remove the currently-loaded model — switch away first.
#[utoipa::path(
    delete,
    path = "/models/{name}",
    tag = "models",
    params(("name" = String, Path, description = "Model name to uninstall.")),
    responses(
        (status = 200, description = "Model weights removed.", body = DeleteModelResponse),
        (status = 404, description = "Unknown model name.", body = crate::routes::ApiErrorBody),
        (status = 409, description = "Model weights missing or cannot be removed.", body = crate::routes::ApiErrorBody),
        (status = 500, description = "Filesystem error removing the weights.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn delete_model(
    State(state): State<Arc<AppState>>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<DeleteModelResponse>, ApiError> {
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
    Ok(Json(DeleteModelResponse {
        name,
        removed: true,
    }))
}

/// `GET /models/download/{name}` progress body. Two genuinely-disjoint wire
/// shapes → an untagged enum (utoipa emits a `oneOf`), so the schema can never
/// mix the `installed` flag with the progress byte-counters:
///
/// - [`Installed`](Self::Installed) — no live job drives progress: either the
///   weights are on disk (`status = "done"`, `installed = true`) or nothing is
///   happening (`status = "idle"`, `installed = false`).
/// - [`Progress`](Self::Progress) — a live or terminal job's counters;
///   `total_bytes` and `error` are emitted as `null` when unknown (never
///   omitted), matching the prior ad-hoc JSON.
#[derive(Serialize, utoipa::ToSchema)]
#[serde(untagged)]
pub enum DownloadStatusResponse {
    Installed {
        name: String,
        status: String,
        installed: bool,
    },
    Progress {
        name: String,
        status: String,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        error: Option<String>,
    },
}

#[utoipa::path(
    get,
    path = "/models/download/{name}",
    tag = "models",
    params(("name" = String, Path, description = "Model name whose download progress to read.")),
    responses(
        (status = 200, description = "Current download progress: an `installed` form (`status` \"done\"/\"idle\" + `installed`) or a `progress` form (byte counters).", body = DownloadStatusResponse),
        (status = 404, description = "No active download for that model.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn download_status(
    State(state): State<Arc<AppState>>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<DownloadStatusResponse>, ApiError> {
    // Installed-on-disk always wins, even across restarts (job map is
    // process-local).
    if registry::resolve_named_model(&state.config, &name).is_ok() {
        return Ok(Json(DownloadStatusResponse::Installed {
            name,
            status: "done".to_string(),
            installed: true,
        }));
    }
    let jobs = state.downloads.jobs.lock().expect("dl lock");
    match jobs.get(&name) {
        Some(j) => Ok(Json(DownloadStatusResponse::Progress {
            name: name.clone(),
            status: j.status.to_string(),
            downloaded_bytes: j.downloaded_bytes,
            total_bytes: j.total_bytes,
            error: j.error.clone(),
        })),
        None => Ok(Json(DownloadStatusResponse::Installed {
            name,
            status: "idle".to_string(),
            installed: false,
        })),
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

#[cfg(test)]
mod wire_shape_tests {
    //! Task 1.7: each `/models*` success body serializes byte-identically to
    //! the ad-hoc `json!()` the handler produced before typing — one test per
    //! state for the state-dependent endpoints.
    use super::*;
    use serde_json::json;

    #[test]
    fn models_list_shape() {
        let s = ModelsListResponse {
            active: "base".to_string(),
            loaded: true,
            models: vec![registry::ModelListing {
                name: "base".to_string(),
                description: Some("Base model".to_string()),
                license: None,
                size: None,
                languages: vec!["en".to_string()],
                recommended: true,
                speed: Some(1.5),
                accuracy: None,
                tags: vec!["fast".to_string()],
                formats: vec!["ggml".to_string()],
                installed: false,
                runnable: true,
            }],
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "active": "base",
                "loaded": true,
                "models": [{
                    "name": "base",
                    "description": "Base model",
                    "license": null,
                    "size": null,
                    "languages": ["en"],
                    "recommended": true,
                    "speed": 1.5,
                    "accuracy": null,
                    "tags": ["fast"],
                    "formats": ["ggml"],
                    "installed": false,
                    "runnable": true
                }]
            })
        );
    }

    #[test]
    fn set_active_swapped_true_includes_load_time() {
        let s = SetActiveResponse {
            active: "base".to_string(),
            swapped: true,
            load_time_ms: Some(1234),
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"active": "base", "swapped": true, "load_time_ms": 1234})
        );
    }

    #[test]
    fn set_active_swapped_false_omits_load_time() {
        let s = SetActiveResponse {
            active: "base".to_string(),
            swapped: false,
            load_time_ms: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"active": "base", "swapped": false})
        );
    }

    #[test]
    fn download_already_present_state() {
        let s = DownloadResponse {
            name: "base".to_string(),
            status: "done".to_string(),
            already_present: Some(true),
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"name": "base", "status": "done", "already_present": true})
        );
    }

    #[test]
    fn download_downloading_state_omits_already_present() {
        let s = DownloadResponse {
            name: "base".to_string(),
            status: "downloading".to_string(),
            already_present: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"name": "base", "status": "downloading"})
        );
    }

    #[test]
    fn download_status_done_installed_state() {
        let s = DownloadStatusResponse::Installed {
            name: "base".to_string(),
            status: "done".to_string(),
            installed: true,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"name": "base", "status": "done", "installed": true})
        );
    }

    #[test]
    fn download_status_idle_state() {
        let s = DownloadStatusResponse::Installed {
            name: "base".to_string(),
            status: "idle".to_string(),
            installed: false,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"name": "base", "status": "idle", "installed": false})
        );
    }

    #[test]
    fn download_status_progress_state_emits_null_totals() {
        let s = DownloadStatusResponse::Progress {
            name: "base".to_string(),
            status: "downloading".to_string(),
            downloaded_bytes: 1024,
            total_bytes: None,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "name": "base",
                "status": "downloading",
                "downloaded_bytes": 1024,
                "total_bytes": null,
                "error": null
            })
        );
    }

    #[test]
    fn download_status_progress_state_with_totals_and_error() {
        let s = DownloadStatusResponse::Progress {
            name: "base".to_string(),
            status: "error".to_string(),
            downloaded_bytes: 1024,
            total_bytes: Some(4096),
            error: Some("boom".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "name": "base",
                "status": "error",
                "downloaded_bytes": 1024,
                "total_bytes": 4096,
                "error": "boom"
            })
        );
    }

    #[test]
    fn cancel_download_state() {
        let s = CancelDownloadResponse {
            name: "base".to_string(),
            status: "cancelling".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"name": "base", "status": "cancelling"})
        );
    }

    #[test]
    fn delete_model_state() {
        let s = DeleteModelResponse {
            name: "base".to_string(),
            removed: true,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"name": "base", "removed": true})
        );
    }
}
