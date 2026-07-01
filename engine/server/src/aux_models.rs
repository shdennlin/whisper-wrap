//! Auxiliary (non-ASR) model management: the diarization (speaker-separation)
//! and VAD ONNX models. These are direct-URL downloads (sherpa-onnx releases /
//! HuggingFace), so this mirrors the ASR `/models` surface but without the
//! registry/variant machinery — a small fixed catalogue is enough.
//!
//! Routes (lib.rs):
//!   GET    /aux-models                 list + installed status
//!   POST   /aux-models/download {id}   start a download (pollable)
//!   GET    /aux-models/download/{id}   progress
//!   DELETE /aux-models/download/{id}   cancel (reuses models::cancel_download)

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::Json;
use serde::{Deserialize, Serialize};

use crate::models::{copy_with_progress, CopyOutcome, DownloadJob};
use crate::routes::ApiError;
use crate::state::AppState;

struct AuxModel {
    id: &'static str,
    /// Pipeline stage this model serves: "diarize" | "vad".
    stage: &'static str,
    url: &'static str,
    /// Known content length (bytes) so the UI can show a size before download.
    size_bytes: u64,
    /// The stage genuinely cannot run without this exact model.
    required: bool,
    /// The default/suggested pick among interchangeable options (e.g. the fast
    /// embedding tier). Not strictly required, but recommended.
    recommended: bool,
}

/// The fixed catalogue. URLs + sizes verified against the sherpa-onnx releases.
const AUX_MODELS: &[AuxModel] = &[
    AuxModel {
        id: "diarize-segmentation",
        stage: "diarize",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx",
        size_bytes: 5_992_913,
        required: true,
        recommended: false,
    },
    AuxModel {
        id: "diarize-embedding-fast",
        stage: "diarize",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
        size_bytes: 28_281_138,
        required: false,
        recommended: true,
    },
    AuxModel {
        id: "diarize-embedding-balanced",
        stage: "diarize",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
        size_bytes: 71_441_526,
        required: false,
        recommended: false,
    },
    AuxModel {
        id: "vad-silero",
        stage: "vad",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
        size_bytes: 643_854,
        required: false,
        recommended: false,
    },
];

fn find(id: &str) -> Option<&'static AuxModel> {
    AUX_MODELS.iter().find(|m| m.id == id)
}

/// Resolve the on-disk destination for an aux model from the engine config.
fn dest_for(config: &whisper_wrap_core::Config, id: &str) -> Option<PathBuf> {
    Some(match id {
        "diarize-segmentation" => config.diarize_seg_model.clone(),
        "diarize-embedding-fast" => config.diarize_emb_model.clone(),
        "diarize-embedding-balanced" => config.diarize_emb_model_balanced.clone(),
        "vad-silero" => config.silero_vad_model.clone(),
        _ => return None,
    })
}

/// One row of `GET /aux-models` — a catalogue entry plus its on-disk install
/// state. Keys and types mirror the prior ad-hoc JSON exactly.
#[derive(Serialize, utoipa::ToSchema)]
pub struct AuxModelEntry {
    id: String,
    stage: String,
    size_bytes: u64,
    required: bool,
    recommended: bool,
    installed: bool,
}

/// `GET /aux-models` success body: the fixed auxiliary-model catalogue with
/// per-entry install state.
#[derive(Serialize, utoipa::ToSchema)]
pub struct AuxListResponse {
    models: Vec<AuxModelEntry>,
}

#[utoipa::path(
    get,
    path = "/aux-models",
    tag = "models",
    operation_id = "aux_models_list",
    responses((status = 200, description = "Auxiliary (diarization + VAD) models with install state.", body = AuxListResponse))
)]
pub async fn list(State(state): State<Arc<AppState>>) -> Json<AuxListResponse> {
    let models: Vec<AuxModelEntry> = AUX_MODELS
        .iter()
        .map(|m| {
            let installed = dest_for(&state.config, m.id)
                .map(|p| p.is_file())
                .unwrap_or(false);
            AuxModelEntry {
                id: m.id.to_string(),
                stage: m.stage.to_string(),
                size_bytes: m.size_bytes,
                required: m.required,
                recommended: m.recommended,
                installed,
            }
        })
        .collect();
    Json(AuxListResponse { models })
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct AuxDownloadRequest {
    id: String,
}

/// `POST /aux-models/download` success body. Mirrors `models::DownloadResponse`
/// but keyed by `id`: two states share the `id` + `status` discriminant — a
/// `status = "done"` response carries `already_present: true`, a
/// `status = "downloading"` response omits `already_present`.
#[derive(Serialize, utoipa::ToSchema)]
pub struct AuxDownloadResponse {
    id: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    already_present: Option<bool>,
}

/// Start (or report an already-running) download. Returns immediately; poll
/// GET /aux-models/download/{id}.
#[utoipa::path(
    post,
    path = "/aux-models/download",
    tag = "models",
    operation_id = "aux_models_download",
    request_body(content = AuxDownloadRequest, description = "The auxiliary model id to download."),
    responses(
        (status = 200, description = "Download started/queued, or already present. `status = \"done\"` adds `already_present: true`; `status = \"downloading\"` omits it.", body = AuxDownloadResponse),
        (status = 404, description = "Unknown auxiliary model id.", body = crate::routes::ApiErrorBody),
        (status = 500, description = "Download setup failure.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn download(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AuxDownloadRequest>,
) -> Result<Json<AuxDownloadResponse>, ApiError> {
    let m = find(&req.id)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("unknown aux model {}", req.id)))?;
    let dest = dest_for(&state.config, &req.id)
        .ok_or_else(|| ApiError::internal(format!("no dest for {}", req.id)))?;

    if dest.is_file() {
        return Ok(Json(AuxDownloadResponse {
            id: req.id.clone(),
            status: "done".to_string(),
            already_present: Some(true),
        }));
    }

    {
        let mut jobs = state.downloads.jobs.lock().expect("dl lock");
        if let Some(j) = jobs.get(&req.id) {
            if j.status == "downloading" {
                return Ok(Json(AuxDownloadResponse {
                    id: req.id.clone(),
                    status: "downloading".to_string(),
                    already_present: None,
                }));
            }
        }
        jobs.insert(req.id.clone(), DownloadJob::started());
    }

    let st = Arc::clone(&state);
    let id = req.id.clone();
    let url = m.url.to_string();
    tokio::task::spawn_blocking(move || run_aux_download(st, id, url, dest));

    Ok(Json(AuxDownloadResponse {
        id: req.id,
        status: "downloading".to_string(),
        already_present: None,
    }))
}

fn run_aux_download(state: Arc<AppState>, id: String, url: String, dest: PathBuf) {
    let set = |status: &'static str, err: Option<String>| {
        if let Some(j) = state.downloads.jobs.lock().expect("dl lock").get_mut(&id) {
            j.status = status;
            j.error = err;
        }
    };

    if let Some(parent) = dest.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return set("error", Some(e.to_string()));
        }
    }

    let resp = match ureq::get(&url).call() {
        Ok(r) => r,
        Err(e) => return set("error", Some(format!("download failed: {e}"))),
    };
    let total: Option<u64> = resp.header("content-length").and_then(|v| v.parse().ok());
    if let Some(j) = state.downloads.jobs.lock().expect("dl lock").get_mut(&id) {
        j.total_bytes = total;
    }
    let cancel = match state.downloads.jobs.lock().expect("dl lock").get(&id) {
        Some(j) => Arc::clone(&j.cancel),
        None => return,
    };

    // Stream into a `.part` sibling; rename only on success so a killed or
    // cancelled download can never be mistaken for an installed model.
    let part = dest.with_extension("part");
    let outcome = (|| {
        let file = std::fs::File::create(&part)?;
        let mut writer = std::io::BufWriter::new(file);
        let out = copy_with_progress(resp.into_reader(), &mut writer, &cancel, |bytes| {
            if let Some(j) = state.downloads.jobs.lock().expect("dl lock").get_mut(&id) {
                j.downloaded_bytes = bytes;
            }
        })?;
        std::io::Write::flush(&mut writer)?;
        Ok::<CopyOutcome, std::io::Error>(out)
    })();

    match outcome {
        Ok(CopyOutcome::Done(bytes)) => {
            if let Err(e) = std::fs::rename(&part, &dest) {
                let _ = std::fs::remove_file(&part);
                return set("error", Some(format!("finalize download failed: {e}")));
            }
            log::info!("aux model {id} downloaded ({bytes} bytes) → {}", dest.display());
            set("done", None);
        }
        Ok(CopyOutcome::Cancelled) => {
            let _ = std::fs::remove_file(&part);
            log::info!("aux model {id} download cancelled");
            set("cancelled", None);
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            set("error", Some(format!("download failed: {e}")));
        }
    }
}

/// `GET /aux-models/download/{id}` progress body. Mirrors
/// `models::DownloadStatusResponse` but keyed by `id`: two disjoint wire shapes
/// → an untagged enum (utoipa emits a `oneOf`) so `installed` never mixes with
/// the progress byte-counters.
///
/// - [`Installed`](Self::Installed) — weights on disk (`status = "done"`,
///   `installed = true`) or nothing happening (`status = "idle"`,
///   `installed = false`).
/// - [`Progress`](Self::Progress) — a job's byte counters; `total_bytes` and
///   `error` are emitted as `null` when unknown (never omitted).
#[derive(Serialize, utoipa::ToSchema)]
#[serde(untagged)]
pub enum AuxDownloadStatusResponse {
    Installed {
        id: String,
        status: String,
        installed: bool,
    },
    Progress {
        id: String,
        status: String,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        error: Option<String>,
    },
}

#[utoipa::path(
    get,
    path = "/aux-models/download/{id}",
    tag = "models",
    operation_id = "aux_models_download_status",
    params(("id" = String, Path, description = "Auxiliary model id whose download progress to read.")),
    responses((status = 200, description = "Current download progress: an `installed` form (`status` \"done\"/\"idle\" + `installed`) or a `progress` form (byte counters).", body = AuxDownloadStatusResponse))
)]
pub async fn download_status(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Json<AuxDownloadStatusResponse> {
    // Installed-on-disk always wins (the job map is process-local).
    if dest_for(&state.config, &id)
        .map(|p| p.is_file())
        .unwrap_or(false)
    {
        return Json(AuxDownloadStatusResponse::Installed {
            id,
            status: "done".to_string(),
            installed: true,
        });
    }
    let jobs = state.downloads.jobs.lock().expect("dl lock");
    match jobs.get(&id) {
        Some(j) => Json(AuxDownloadStatusResponse::Progress {
            id: id.clone(),
            status: j.status.to_string(),
            downloaded_bytes: j.downloaded_bytes,
            total_bytes: j.total_bytes,
            error: j.error.clone(),
        }),
        None => Json(AuxDownloadStatusResponse::Installed {
            id,
            status: "idle".to_string(),
            installed: false,
        }),
    }
}

/// `DELETE /aux-models/{id}` acknowledgement: the removed id and a constant
/// `removed: true` flag.
#[derive(Serialize, utoipa::ToSchema)]
pub struct AuxDeleteModelResponse {
    id: String,
    removed: bool,
}

/// Uninstall an aux model (delete its ONNX file from disk).
#[utoipa::path(
    delete,
    path = "/aux-models/{id}",
    tag = "models",
    operation_id = "aux_models_delete_model",
    params(("id" = String, Path, description = "Auxiliary model id to uninstall.")),
    responses(
        (status = 200, description = "Auxiliary model weights removed.", body = AuxDeleteModelResponse),
        (status = 404, description = "Unknown auxiliary model id.", body = crate::routes::ApiErrorBody),
        (status = 500, description = "Filesystem error removing the weights.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn delete_model(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<AuxDeleteModelResponse>, ApiError> {
    let dest = dest_for(&state.config, &id)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("unknown aux model {id}")))?;
    if dest.is_file() {
        std::fs::remove_file(&dest).map_err(ApiError::internal)?;
        log::info!("removed aux model {id} → {}", dest.display());
    }
    Ok(Json(AuxDeleteModelResponse {
        id,
        removed: true,
    }))
}

/// `DELETE /aux-models/download/{id}` acknowledgement: the aux id and the
/// resulting download `status` — `"cancelling"` when a live download was asked
/// to stop, otherwise the job's current (terminal) status.
#[derive(Serialize, utoipa::ToSchema)]
pub struct AuxCancelDownloadResponse {
    id: String,
    status: String,
}

/// Cancel an in-flight aux download (mirror of models::cancel_download, keyed
/// by aux id). The worker notices the flag between chunks.
#[utoipa::path(
    delete,
    path = "/aux-models/download/{id}",
    tag = "models",
    operation_id = "aux_models_cancel_download",
    params(("id" = String, Path, description = "Auxiliary model id whose download to cancel.")),
    responses(
        (status = 200, description = "Download cancellation acknowledged.", body = AuxCancelDownloadResponse),
        (status = 404, description = "No active download for that auxiliary model.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn cancel_download(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<AuxCancelDownloadResponse>, ApiError> {
    let jobs = state.downloads.jobs.lock().expect("dl lock");
    match jobs.get(&id) {
        Some(j) if j.status == "downloading" => {
            j.cancel.store(true, Ordering::Relaxed);
            Ok(Json(AuxCancelDownloadResponse {
                id: id.clone(),
                status: "cancelling".to_string(),
            }))
        }
        Some(j) => Ok(Json(AuxCancelDownloadResponse {
            id: id.clone(),
            status: j.status.to_string(),
        })),
        None => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            format!("no download for {id}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_ids_resolve_to_distinct_config_paths() {
        let c = whisper_wrap_core::Config::from_env();
        let mut seen = std::collections::HashSet::new();
        for m in AUX_MODELS {
            let dest = dest_for(&c, m.id).expect("every catalogue id has a dest");
            assert!(seen.insert(dest.clone()), "duplicate dest path: {}", dest.display());
        }
    }

    #[test]
    fn unknown_id_has_no_dest() {
        let c = whisper_wrap_core::Config::from_env();
        assert!(dest_for(&c, "ghost").is_none());
        assert!(find("ghost").is_none());
    }

    #[test]
    fn only_segmentation_is_required_embeddings_are_a_choice() {
        // Segmentation is the only genuinely-required model; the two embeddings
        // are interchangeable tiers (fast is recommended, not required).
        let required: Vec<_> = AUX_MODELS
            .iter()
            .filter(|m| m.required)
            .map(|m| m.id)
            .collect();
        assert_eq!(required, vec!["diarize-segmentation"]);
        assert!(find("diarize-embedding-fast").unwrap().recommended);
        assert!(!find("diarize-embedding-fast").unwrap().required);
        assert!(!find("diarize-embedding-balanced").unwrap().recommended);
    }
}

#[cfg(test)]
mod wire_shape_tests {
    //! Task 1.8: each `/aux-models*` success body serializes byte-identically
    //! to the ad-hoc `json!()` the handler produced before typing — one test
    //! per state for the state-dependent endpoints. Keyed by `id` (vs `name`
    //! in `models.rs`).
    use super::*;
    use serde_json::json;

    #[test]
    fn aux_list_shape() {
        let s = AuxListResponse {
            models: vec![AuxModelEntry {
                id: "vad-silero".to_string(),
                stage: "vad".to_string(),
                size_bytes: 643_854,
                required: false,
                recommended: false,
                installed: true,
            }],
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "models": [{
                    "id": "vad-silero",
                    "stage": "vad",
                    "size_bytes": 643_854,
                    "required": false,
                    "recommended": false,
                    "installed": true
                }]
            })
        );
    }

    #[test]
    fn aux_download_already_present_state() {
        let s = AuxDownloadResponse {
            id: "vad-silero".to_string(),
            status: "done".to_string(),
            already_present: Some(true),
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"id": "vad-silero", "status": "done", "already_present": true})
        );
    }

    #[test]
    fn aux_download_downloading_state_omits_already_present() {
        let s = AuxDownloadResponse {
            id: "vad-silero".to_string(),
            status: "downloading".to_string(),
            already_present: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"id": "vad-silero", "status": "downloading"})
        );
    }

    #[test]
    fn aux_download_status_done_installed_state() {
        let s = AuxDownloadStatusResponse::Installed {
            id: "vad-silero".to_string(),
            status: "done".to_string(),
            installed: true,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"id": "vad-silero", "status": "done", "installed": true})
        );
    }

    #[test]
    fn aux_download_status_idle_state() {
        let s = AuxDownloadStatusResponse::Installed {
            id: "vad-silero".to_string(),
            status: "idle".to_string(),
            installed: false,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"id": "vad-silero", "status": "idle", "installed": false})
        );
    }

    #[test]
    fn aux_download_status_progress_state_emits_null_totals() {
        let s = AuxDownloadStatusResponse::Progress {
            id: "vad-silero".to_string(),
            status: "downloading".to_string(),
            downloaded_bytes: 2048,
            total_bytes: None,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "id": "vad-silero",
                "status": "downloading",
                "downloaded_bytes": 2048,
                "total_bytes": null,
                "error": null
            })
        );
    }

    #[test]
    fn aux_download_status_progress_state_with_totals_and_error() {
        let s = AuxDownloadStatusResponse::Progress {
            id: "vad-silero".to_string(),
            status: "error".to_string(),
            downloaded_bytes: 2048,
            total_bytes: Some(8192),
            error: Some("boom".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "id": "vad-silero",
                "status": "error",
                "downloaded_bytes": 2048,
                "total_bytes": 8192,
                "error": "boom"
            })
        );
    }

    #[test]
    fn aux_cancel_download_state() {
        let s = AuxCancelDownloadResponse {
            id: "vad-silero".to_string(),
            status: "cancelling".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"id": "vad-silero", "status": "cancelling"})
        );
    }

    #[test]
    fn aux_delete_model_state() {
        let s = AuxDeleteModelResponse {
            id: "vad-silero".to_string(),
            removed: true,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"id": "vad-silero", "removed": true})
        );
    }
}
