//! Model registry — parses `registry/models.yaml` and resolves the
//! active ggml variant. Port of `app/services/registry.py`, ggml-only:
//! v3 has a single backend (whisper-rs), so the ct2/ggml dual-variant
//! resolution collapses to "find the ggml variant".
//!
//! Resolution precedence (matches v2):
//!   1. MODEL_DIR override — registry not consulted; the path is used
//!      directly (a `.bin` file, or a directory containing one).
//!   2. MODEL_NAME → registry lookup → ggml variant.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use thiserror::Error;

use crate::config::Config;

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("registry file not readable: {0}")]
    Io(#[from] std::io::Error),
    #[error("registry parse error: {0}")]
    Parse(#[from] serde_yaml::Error),
    #[error("model {0:?} not found in registry")]
    UnknownModel(String),
    #[error("model {0:?} has no ggml variant (v3 engine is ggml-only)")]
    NoGgmlVariant(String),
    #[error("model file not found: {0} — fetch it via POST /models/download (Models screen in the app)")]
    ModelFileMissing(PathBuf),
    #[error("MODEL_DIR {0} contains no .bin model file")]
    EmptyModelDir(PathBuf),
}

#[derive(Debug, Deserialize)]
struct RegistryFile {
    models: BTreeMap<String, ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    description: Option<String>,
    /// Weight license (optional). UI shows "see model card" when absent.
    license: Option<String>,
    /// Approximate disk footprint, e.g. "466 MB" (optional, display-only).
    size: Option<String>,
    /// Supported language tags, e.g. ["zh-TW","en"] or ["multilingual"].
    #[serde(default)]
    languages: Vec<String>,
    /// Surface this model in the "recommended" set in the picker.
    #[serde(default)]
    recommended: bool,
    /// Rough 0–10 ratings for the picker (display-only, curated).
    speed: Option<f64>,
    accuracy: Option<f64>,
    variants: Vec<Variant>,
}

#[derive(Debug, Deserialize)]
struct Variant {
    format: String,
    local_dir: Option<String>,
    filename: Option<String>,
    coreml_encoder: Option<String>,
    quant: Option<String>,
    repo_id: Option<String>,
    subfolder: Option<String>,
}

/// The fully resolved active model — everything /status needs to report.
#[derive(Debug, Clone)]
pub struct ResolvedModel {
    pub name: String,
    pub bin_path: PathBuf,
    pub format: &'static str,
    pub quant: Option<String>,
    pub coreml_encoder: Option<PathBuf>,
}

pub fn resolve_active_model(config: &Config) -> Result<ResolvedModel, RegistryError> {
    if let Some(dir) = &config.model_dir {
        return resolve_model_dir_override(dir, &config.model_name);
    }
    resolve_named_model(config, &config.model_name)
}

/// Like [`resolve_active_model`] but tolerates absent weights (see
/// [`resolve_named_model_lenient`]). For the `MODEL_DIR` override path the
/// weights must still be present — that path is an explicit power-user
/// pointer at a real directory, not the first-run install case.
pub fn resolve_active_model_lenient(config: &Config) -> Result<ResolvedModel, RegistryError> {
    if let Some(dir) = &config.model_dir {
        return resolve_model_dir_override(dir, &config.model_name);
    }
    resolve_named_model_lenient(config, &config.model_name)
}

/// Resolve a registry model by name (ggml variant). Used by the
/// active-model resolution AND the hot-swap endpoint. Fails with
/// `ModelFileMissing` if the weights are not on disk.
pub fn resolve_named_model(config: &Config, name: &str) -> Result<ResolvedModel, RegistryError> {
    resolve_named_model_inner(config, name, true)
}

/// Like [`resolve_named_model`] but does NOT require the weights to exist —
/// returns the resolved spec (name, expected `bin_path`, …) even when the
/// file is absent. Used at boot so a fresh install (zero weights) can still
/// start the window + server and drive the first-run download flow, instead
/// of crashing on `ModelFileMissing`.
///
/// Requires the variant to declare an explicit `filename`; without one we
/// can only find the binary by scanning the dir, which is empty on a fresh
/// install (that falls back to the same scan and may still error).
pub fn resolve_named_model_lenient(
    config: &Config,
    name: &str,
) -> Result<ResolvedModel, RegistryError> {
    resolve_named_model_inner(config, name, false)
}

fn resolve_named_model_inner(
    config: &Config,
    name: &str,
    require_file: bool,
) -> Result<ResolvedModel, RegistryError> {
    let raw = std::fs::read_to_string(&config.registry_path)?;
    let registry: RegistryFile = serde_yaml::from_str(&raw)?;
    let entry = registry
        .models
        .get(name)
        .ok_or_else(|| RegistryError::UnknownModel(name.to_owned()))?;
    let variant = entry
        .variants
        .iter()
        .find(|v| v.format == "ggml")
        .ok_or_else(|| RegistryError::NoGgmlVariant(name.to_owned()))?;

    let local_dir = config
        .models_dir
        .join(variant.local_dir.as_deref().unwrap_or(name));
    let bin_path = match &variant.filename {
        // A declared filename lets us name the expected path without it
        // existing yet — the lenient boot case.
        Some(f) => local_dir.join(f),
        None => first_bin_in(&local_dir)?,
    };
    if require_file && !bin_path.is_file() {
        return Err(RegistryError::ModelFileMissing(bin_path));
    }
    Ok(ResolvedModel {
        name: name.to_owned(),
        coreml_encoder: variant
            .coreml_encoder
            .as_ref()
            .map(|d| local_dir.join(d))
            .filter(|p| p.exists()),
        quant: variant.quant.clone(),
        format: "ggml",
        bin_path,
    })
}

/// One row of GET /models — registry entry + installed status.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelListing {
    pub name: String,
    pub description: Option<String>,
    pub license: Option<String>,
    pub size: Option<String>,
    pub languages: Vec<String>,
    pub recommended: bool,
    pub speed: Option<f64>,
    pub accuracy: Option<f64>,
    pub formats: Vec<String>,
    pub installed: bool,
    /// True when this model has a ggml variant (v3 can run it).
    pub runnable: bool,
}

pub fn list_models(config: &Config) -> Result<Vec<ModelListing>, RegistryError> {
    let raw = std::fs::read_to_string(&config.registry_path)?;
    let registry: RegistryFile = serde_yaml::from_str(&raw)?;
    Ok(registry
        .models
        .iter()
        .map(|(name, entry)| ModelListing {
            name: name.clone(),
            description: entry.description.clone(),
            license: entry.license.clone(),
            size: entry.size.clone(),
            languages: entry.languages.clone(),
            recommended: entry.recommended,
            speed: entry.speed,
            accuracy: entry.accuracy,
            formats: entry.variants.iter().map(|v| v.format.clone()).collect(),
            installed: resolve_named_model(config, name).is_ok(),
            runnable: entry.variants.iter().any(|v| v.format == "ggml"),
        })
        .collect())
}

/// What the download endpoint needs to fetch a model's ggml weights.
#[derive(Debug, Clone)]
pub struct DownloadSpec {
    pub repo_id: String,
    pub filename: String,
    pub subfolder: Option<String>,
    pub dest_dir: PathBuf,
    pub dest_file: PathBuf,
}

pub fn ggml_download_spec(config: &Config, name: &str) -> Result<DownloadSpec, RegistryError> {
    let raw = std::fs::read_to_string(&config.registry_path)?;
    let registry: RegistryFile = serde_yaml::from_str(&raw)?;
    let entry = registry
        .models
        .get(name)
        .ok_or_else(|| RegistryError::UnknownModel(name.to_owned()))?;
    let variant = entry
        .variants
        .iter()
        .find(|v| v.format == "ggml")
        .ok_or_else(|| RegistryError::NoGgmlVariant(name.to_owned()))?;
    let repo_id = variant.repo_id.clone().ok_or_else(|| {
        RegistryError::UnknownModel(format!("{name} ggml variant has no repo_id"))
    })?;
    let filename = variant.filename.clone().ok_or_else(|| {
        RegistryError::UnknownModel(format!("{name} ggml variant has no filename"))
    })?;
    let dest_dir = config
        .models_dir
        .join(variant.local_dir.as_deref().unwrap_or(name));
    let dest_file = dest_dir.join(&filename);
    Ok(DownloadSpec {
        repo_id,
        filename,
        subfolder: variant.subfolder.clone(),
        dest_dir,
        dest_file,
    })
}

fn resolve_model_dir_override(dir: &Path, name: &str) -> Result<ResolvedModel, RegistryError> {
    let bin_path = if dir.is_file() {
        dir.to_path_buf()
    } else {
        first_bin_in(dir)?
    };
    Ok(ResolvedModel {
        name: name.to_owned(),
        bin_path,
        format: "ggml",
        quant: None,
        coreml_encoder: None,
    })
}

fn first_bin_in(dir: &Path) -> Result<PathBuf, RegistryError> {
    let mut bins: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "bin"))
        .collect();
    bins.sort();
    bins.into_iter()
        .next()
        .ok_or_else(|| RegistryError::EmptyModelDir(dir.to_path_buf()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
models:
  breeze-asr-25:
    description: "test"
    variants:
      - format: ct2
        local_dir: breeze-asr-25-ct2
        compute_type: int8_float16
      - format: ggml
        quant: q6_k
        filename: ggml-breeze-asr-25-q6_k.bin
        coreml_encoder: ggml-breeze-asr-25-encoder.mlmodelc
        local_dir: breeze-asr-25-ggml
  ct2-only:
    variants:
      - format: ct2
        local_dir: x
"#;

    #[test]
    fn parses_real_registry_shape() {
        let reg: RegistryFile = serde_yaml::from_str(SAMPLE).unwrap();
        let entry = &reg.models["breeze-asr-25"];
        let ggml = entry.variants.iter().find(|v| v.format == "ggml").unwrap();
        assert_eq!(
            ggml.filename.as_deref(),
            Some("ggml-breeze-asr-25-q6_k.bin")
        );
        assert_eq!(ggml.quant.as_deref(), Some("q6_k"));
    }

    #[test]
    fn ct2_only_model_is_rejected() {
        let reg: RegistryFile = serde_yaml::from_str(SAMPLE).unwrap();
        let entry = &reg.models["ct2-only"];
        assert!(entry.variants.iter().all(|v| v.format != "ggml"));
    }

    #[test]
    fn lenient_resolve_tolerates_missing_weights() {
        // Strict resolve must fail (no weights), lenient must return the spec
        // with the expected — absent — path. This is the first-run boot case.
        let base = std::env::temp_dir().join("ww-registry-lenient-test");
        let _ = std::fs::create_dir_all(&base);
        let reg_path = base.join("models.yaml");
        std::fs::write(&reg_path, SAMPLE).unwrap();

        let mut config = Config::from_env();
        config.registry_path = reg_path;
        config.models_dir = base.join("models-empty"); // does not exist
        config.model_dir = None;
        config.model_name = "breeze-asr-25".into();

        assert!(matches!(
            resolve_named_model(&config, "breeze-asr-25"),
            Err(RegistryError::ModelFileMissing(_))
        ));

        let m = resolve_named_model_lenient(&config, "breeze-asr-25").unwrap();
        assert_eq!(m.name, "breeze-asr-25");
        assert!(m.bin_path.ends_with("ggml-breeze-asr-25-q6_k.bin"));
        assert!(!m.bin_path.is_file());

        let _ = std::fs::remove_dir_all(&base);
    }
}
