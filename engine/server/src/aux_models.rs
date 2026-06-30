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
use serde::Deserialize;
use serde_json::json;

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

pub async fn list(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let models: Vec<_> = AUX_MODELS
        .iter()
        .map(|m| {
            let installed = dest_for(&state.config, m.id)
                .map(|p| p.is_file())
                .unwrap_or(false);
            json!({
                "id": m.id,
                "stage": m.stage,
                "size_bytes": m.size_bytes,
                "required": m.required,
                "recommended": m.recommended,
                "installed": installed,
            })
        })
        .collect();
    Json(json!({ "models": models }))
}

#[derive(Deserialize)]
pub struct AuxDownloadRequest {
    id: String,
}

/// Start (or report an already-running) download. Returns immediately; poll
/// GET /aux-models/download/{id}.
pub async fn download(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AuxDownloadRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let m = find(&req.id)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("unknown aux model {}", req.id)))?;
    let dest = dest_for(&state.config, &req.id)
        .ok_or_else(|| ApiError::internal(format!("no dest for {}", req.id)))?;

    if dest.is_file() {
        return Ok(Json(
            json!({"id": req.id, "status": "done", "already_present": true}),
        ));
    }

    {
        let mut jobs = state.downloads.jobs.lock().expect("dl lock");
        if let Some(j) = jobs.get(&req.id) {
            if j.status == "downloading" {
                return Ok(Json(json!({"id": req.id, "status": "downloading"})));
            }
        }
        jobs.insert(req.id.clone(), DownloadJob::started());
    }

    let st = Arc::clone(&state);
    let id = req.id.clone();
    let url = m.url.to_string();
    tokio::task::spawn_blocking(move || run_aux_download(st, id, url, dest));

    Ok(Json(json!({"id": req.id, "status": "downloading"})))
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

pub async fn download_status(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Json<serde_json::Value> {
    // Installed-on-disk always wins (the job map is process-local).
    if dest_for(&state.config, &id)
        .map(|p| p.is_file())
        .unwrap_or(false)
    {
        return Json(json!({"id": id, "status": "done", "installed": true}));
    }
    let jobs = state.downloads.jobs.lock().expect("dl lock");
    match jobs.get(&id) {
        Some(j) => Json(json!({
            "id": id,
            "status": j.status,
            "downloaded_bytes": j.downloaded_bytes,
            "total_bytes": j.total_bytes,
            "error": j.error,
        })),
        None => Json(json!({"id": id, "status": "idle", "installed": false})),
    }
}

/// Uninstall an aux model (delete its ONNX file from disk).
pub async fn delete_model(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let dest = dest_for(&state.config, &id)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("unknown aux model {id}")))?;
    if dest.is_file() {
        std::fs::remove_file(&dest).map_err(ApiError::internal)?;
        log::info!("removed aux model {id} → {}", dest.display());
    }
    Ok(Json(json!({"id": id, "removed": true})))
}

/// Cancel an in-flight aux download (mirror of models::cancel_download, keyed
/// by aux id). The worker notices the flag between chunks.
pub async fn cancel_download(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let jobs = state.downloads.jobs.lock().expect("dl lock");
    match jobs.get(&id) {
        Some(j) if j.status == "downloading" => {
            j.cancel.store(true, Ordering::Relaxed);
            Ok(Json(json!({"id": id, "status": "cancelling"})))
        }
        Some(j) => Ok(Json(json!({"id": id, "status": j.status}))),
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
