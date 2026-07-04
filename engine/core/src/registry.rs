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
    #[error("model {0:?} has no onnx variant (required for parakeet-nemotron backend)")]
    NoOnnxVariant(String),
    #[error("model file not found: {0} — fetch it via POST /models/download (Models screen in the app)")]
    ModelFileMissing(PathBuf),
    #[error("MODEL_DIR {0} contains no .bin model file")]
    EmptyModelDir(PathBuf),
}

/// Which inference backend runs a model. Per-entry in the registry;
/// absent means `whisper-ggml` so every pre-existing entry parses
/// (and resolves) exactly as before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendKind {
    #[default]
    WhisperGgml,
    ParakeetNemotron,
}

/// ONNX artifact files a parakeet-nemotron model needs on disk.
const PARAKEET_ARTIFACTS: [&str; 4] = [
    "encoder.onnx",
    "encoder.onnx.data",
    "decoder_joint.onnx",
    "tokenizer.model",
];

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
    /// Free-form display/filter metadata, e.g. ["code-switching","fast"].
    /// Display/filter only — never affects resolution, runnable, or downloads.
    #[serde(default)]
    tags: Vec<String>,
    /// Inference backend for this model; defaults to whisper-ggml.
    #[serde(default)]
    backend: BackendKind,
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
    /// Path to the model weights. For whisper-ggml this is the `.bin`
    /// file; for parakeet-nemotron it is the artifact DIRECTORY holding
    /// the ONNX file set (encoder/decoder/tokenizer).
    pub bin_path: PathBuf,
    pub format: &'static str,
    pub quant: Option<String>,
    pub coreml_encoder: Option<PathBuf>,
    pub backend: BackendKind,
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

    if entry.backend == BackendKind::ParakeetNemotron {
        return resolve_parakeet(config, name, entry, require_file);
    }

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
        backend: BackendKind::WhisperGgml,
        bin_path,
    })
}

/// Resolve a parakeet-nemotron model: the `onnx` variant names the local
/// artifact directory; `bin_path` is that DIRECTORY (not a file). Strict
/// mode requires the full ONNX artifact set inside it.
fn resolve_parakeet(
    config: &Config,
    name: &str,
    entry: &ModelEntry,
    require_file: bool,
) -> Result<ResolvedModel, RegistryError> {
    let variant = entry
        .variants
        .iter()
        .find(|v| v.format == "onnx")
        .ok_or_else(|| RegistryError::NoOnnxVariant(name.to_owned()))?;
    let artifact_dir = config
        .models_dir
        .join(variant.local_dir.as_deref().unwrap_or(name));
    if require_file {
        for f in PARAKEET_ARTIFACTS {
            let path = artifact_dir.join(f);
            if !path.is_file() {
                return Err(RegistryError::ModelFileMissing(path));
            }
        }
    }
    Ok(ResolvedModel {
        name: name.to_owned(),
        bin_path: artifact_dir,
        format: "onnx",
        quant: None,
        coreml_encoder: None,
        backend: BackendKind::ParakeetNemotron,
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
    /// Free-form display/filter metadata (display only).
    pub tags: Vec<String>,
    pub formats: Vec<String>,
    pub installed: bool,
    /// True when this model has a variant its backend can run
    /// (ggml for whisper-ggml, onnx for parakeet-nemotron).
    pub runnable: bool,
    /// Inference backend for this model (kebab-case in JSON).
    pub backend: BackendKind,
    /// True when the backend transcribes a live stream natively
    /// (parakeet-nemotron), rather than via chunked whisper passes.
    pub supports_native_stream: bool,
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
            tags: entry.tags.clone(),
            formats: entry.variants.iter().map(|v| v.format.clone()).collect(),
            installed: resolve_named_model(config, name).is_ok(),
            runnable: {
                let required = match entry.backend {
                    BackendKind::WhisperGgml => "ggml",
                    BackendKind::ParakeetNemotron => "onnx",
                };
                entry.variants.iter().any(|v| v.format == required)
            },
            backend: entry.backend,
            supports_native_stream: entry.backend == BackendKind::ParakeetNemotron,
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

/// The registry-declared backend for `name`. The download endpoint branches
/// on this to pick the single-file (ggml) vs multi-file (parakeet) plan.
pub fn model_backend(config: &Config, name: &str) -> Result<BackendKind, RegistryError> {
    let raw = std::fs::read_to_string(&config.registry_path)?;
    let registry: RegistryFile = serde_yaml::from_str(&raw)?;
    registry
        .models
        .get(name)
        .map(|e| e.backend)
        .ok_or_else(|| RegistryError::UnknownModel(name.to_owned()))
}

/// The multi-file download plan for a parakeet-nemotron model: one
/// [`DownloadSpec`] per ONNX artifact (the same four files strict resolve
/// requires), all sharing the onnx variant's `repo_id`/`subfolder` and
/// landing in `models_dir/<local_dir>/`.
pub fn parakeet_download_spec(
    config: &Config,
    name: &str,
) -> Result<Vec<DownloadSpec>, RegistryError> {
    let raw = std::fs::read_to_string(&config.registry_path)?;
    let registry: RegistryFile = serde_yaml::from_str(&raw)?;
    let entry = registry
        .models
        .get(name)
        .ok_or_else(|| RegistryError::UnknownModel(name.to_owned()))?;
    let variant = entry
        .variants
        .iter()
        .find(|v| v.format == "onnx")
        .ok_or_else(|| RegistryError::NoOnnxVariant(name.to_owned()))?;
    let repo_id = variant.repo_id.clone().ok_or_else(|| {
        RegistryError::UnknownModel(format!("{name} onnx variant has no repo_id"))
    })?;
    let dest_dir = config
        .models_dir
        .join(variant.local_dir.as_deref().unwrap_or(name));
    Ok(PARAKEET_ARTIFACTS
        .iter()
        .map(|f| DownloadSpec {
            repo_id: repo_id.clone(),
            filename: (*f).to_owned(),
            subfolder: variant.subfolder.clone(),
            dest_dir: dest_dir.clone(),
            dest_file: dest_dir.join(f),
        })
        .collect())
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
        backend: BackendKind::WhisperGgml,
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
    tags:
      - code-switching
      - fast
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
  parakeet-tdt-0.6b:
    description: "parakeet test"
    backend: parakeet-nemotron
    variants:
      - format: onnx
        local_dir: parakeet-tdt-0.6b-onnx
        repo_id: "test-org/parakeet-fixture"
        subfolder: streaming-onnx
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
    fn tags_parse_and_default_empty() {
        // A declared `tags` list parses to exactly those strings in order;
        // an entry that omits the key defaults to an empty vec (parse still
        // succeeds). Tags are display/filter metadata only.
        let reg: RegistryFile = serde_yaml::from_str(SAMPLE).unwrap();
        assert_eq!(
            reg.models["breeze-asr-25"].tags,
            vec!["code-switching".to_string(), "fast".to_string()]
        );
        assert!(reg.models["ct2-only"].tags.is_empty());
    }

    #[test]
    fn tags_flow_through_to_listing() {
        let base = std::env::temp_dir().join("ww-registry-tags-test");
        let _ = std::fs::create_dir_all(&base);
        let reg_path = base.join("models.yaml");
        std::fs::write(&reg_path, SAMPLE).unwrap();

        let mut config = Config::from_env();
        config.registry_path = reg_path;
        config.models_dir = base.join("models-empty");
        config.model_dir = None;

        let listings = list_models(&config).unwrap();
        let breeze = listings.iter().find(|l| l.name == "breeze-asr-25").unwrap();
        assert_eq!(breeze.tags, vec!["code-switching".to_string(), "fast".to_string()]);
        let ct2 = listings.iter().find(|l| l.name == "ct2-only").unwrap();
        assert!(ct2.tags.is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn shipped_registry_breeze_has_backfilled_tags() {
        // Regression guard on the real registry/models.yaml backfill: the
        // shipped breeze-asr-25 row MUST surface tags == [code-switching] and
        // languages == [zh-TW, en] through list_models. Guards the tag data,
        // not just the schema (which SAMPLE-based tests cover).
        let real_registry =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../registry/models.yaml");

        let mut config = Config::from_env();
        config.registry_path = PathBuf::from(real_registry);
        config.models_dir = std::env::temp_dir().join("ww-registry-shipped-empty");
        config.model_dir = None;

        let listings = list_models(&config).unwrap();
        let breeze = listings
            .iter()
            .find(|l| l.name == "breeze-asr-25")
            .expect("breeze-asr-25 in shipped registry");
        assert_eq!(breeze.tags, vec!["code-switching".to_string()]);
        assert_eq!(
            breeze.languages,
            vec!["zh-TW".to_string(), "en".to_string()]
        );
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

    #[test]
    fn backend_defaults_to_whisper_ggml() {
        // Entries that omit `backend` MUST parse to WhisperGgml so every
        // pre-existing registry row keeps resolving exactly as before.
        let reg: RegistryFile = serde_yaml::from_str(SAMPLE).unwrap();
        assert_eq!(reg.models["breeze-asr-25"].backend, BackendKind::WhisperGgml);
        assert_eq!(reg.models["ct2-only"].backend, BackendKind::WhisperGgml);
        assert_eq!(
            reg.models["parakeet-tdt-0.6b"].backend,
            BackendKind::ParakeetNemotron
        );
    }

    #[test]
    fn ggml_resolution_unchanged_for_default_backend() {
        // A backend-less entry still resolves via the ggml variant with an
        // unchanged spec — and now reports backend == WhisperGgml.
        let base = std::env::temp_dir().join("ww-registry-ggml-backend-test");
        let _ = std::fs::create_dir_all(&base);
        let reg_path = base.join("models.yaml");
        std::fs::write(&reg_path, SAMPLE).unwrap();

        let mut config = Config::from_env();
        config.registry_path = reg_path;
        config.models_dir = base.join("models-empty");
        config.model_dir = None;

        let m = resolve_named_model_lenient(&config, "breeze-asr-25").unwrap();
        assert_eq!(m.backend, BackendKind::WhisperGgml);
        assert_eq!(m.format, "ggml");
        assert!(m.bin_path.ends_with("ggml-breeze-asr-25-q6_k.bin"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn listing_exposes_backend_and_native_stream() {
        let base = std::env::temp_dir().join("ww-registry-backend-listing-test");
        let _ = std::fs::create_dir_all(&base);
        let reg_path = base.join("models.yaml");
        std::fs::write(&reg_path, SAMPLE).unwrap();

        let mut config = Config::from_env();
        config.registry_path = reg_path;
        config.models_dir = base.join("models-empty");
        config.model_dir = None;

        let listings = list_models(&config).unwrap();
        let parakeet = listings
            .iter()
            .find(|l| l.name == "parakeet-tdt-0.6b")
            .unwrap();
        assert_eq!(parakeet.backend, BackendKind::ParakeetNemotron);
        assert!(parakeet.supports_native_stream);
        // Runnable because it has an onnx variant (parakeet's runnable rule).
        assert!(parakeet.runnable);

        let breeze = listings.iter().find(|l| l.name == "breeze-asr-25").unwrap();
        assert_eq!(breeze.backend, BackendKind::WhisperGgml);
        assert!(!breeze.supports_native_stream);
        assert!(breeze.runnable);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parakeet_download_spec_covers_all_artifacts() {
        // The multi-file download plan for a parakeet-nemotron model: one
        // DownloadSpec per ONNX artifact, all four, sharing the onnx
        // variant's repo/subfolder and landing in models_dir/<local_dir>/.
        let base = std::env::temp_dir().join("ww-registry-parakeet-dlspec-test");
        let _ = std::fs::create_dir_all(&base);
        let reg_path = base.join("models.yaml");
        std::fs::write(&reg_path, SAMPLE).unwrap();

        let mut config = Config::from_env();
        config.registry_path = reg_path;
        config.models_dir = base.join("models");
        config.model_dir = None;

        let specs = parakeet_download_spec(&config, "parakeet-tdt-0.6b").unwrap();
        let names: Vec<&str> = specs.iter().map(|s| s.filename.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "encoder.onnx",
                "encoder.onnx.data",
                "decoder_joint.onnx",
                "tokenizer.model"
            ]
        );
        let dest_dir = config.models_dir.join("parakeet-tdt-0.6b-onnx");
        for s in &specs {
            assert_eq!(s.repo_id, "test-org/parakeet-fixture");
            assert_eq!(s.subfolder.as_deref(), Some("streaming-onnx"));
            assert_eq!(s.dest_dir, dest_dir);
            assert_eq!(s.dest_file, dest_dir.join(&s.filename));
        }

        // A model without an onnx variant has no parakeet download plan.
        assert!(matches!(
            parakeet_download_spec(&config, "breeze-asr-25"),
            Err(RegistryError::NoOnnxVariant(_))
        ));
        assert!(matches!(
            parakeet_download_spec(&config, "ghost"),
            Err(RegistryError::UnknownModel(_))
        ));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn model_backend_reads_registry_entry() {
        let base = std::env::temp_dir().join("ww-registry-model-backend-test");
        let _ = std::fs::create_dir_all(&base);
        let reg_path = base.join("models.yaml");
        std::fs::write(&reg_path, SAMPLE).unwrap();

        let mut config = Config::from_env();
        config.registry_path = reg_path;
        config.models_dir = base.join("models");
        config.model_dir = None;

        assert_eq!(
            model_backend(&config, "breeze-asr-25").unwrap(),
            BackendKind::WhisperGgml
        );
        assert_eq!(
            model_backend(&config, "parakeet-tdt-0.6b").unwrap(),
            BackendKind::ParakeetNemotron
        );
        assert!(matches!(
            model_backend(&config, "ghost"),
            Err(RegistryError::UnknownModel(_))
        ));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn shipped_registry_has_nemotron_streaming() {
        // Regression guard on the real registry/models.yaml: the shipped
        // nemotron-3.5-streaming row must surface the parakeet-nemotron
        // backend (→ native streaming) and a 4-artifact download plan
        // against the altunenes/parakeet-rs ONNX repo.
        let real_registry =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../registry/models.yaml");

        let mut config = Config::from_env();
        config.registry_path = PathBuf::from(real_registry);
        config.models_dir = std::env::temp_dir().join("ww-registry-shipped-empty");
        config.model_dir = None;

        let listings = list_models(&config).unwrap();
        let nemotron = listings
            .iter()
            .find(|l| l.name == "nemotron-3.5-streaming")
            .expect("nemotron-3.5-streaming in shipped registry");
        assert_eq!(nemotron.backend, BackendKind::ParakeetNemotron);
        assert!(nemotron.supports_native_stream);
        assert!(nemotron.runnable);
        assert_eq!(
            nemotron.tags,
            vec!["streaming".to_string(), "realtime".to_string()]
        );
        assert_eq!(nemotron.languages, vec!["multilingual".to_string()]);
        assert_eq!(nemotron.size.as_deref(), Some("~2.6 GB"));

        let specs = parakeet_download_spec(&config, "nemotron-3.5-streaming").unwrap();
        assert_eq!(specs.len(), 4);
        for s in &specs {
            assert_eq!(s.repo_id, "altunenes/parakeet-rs");
            assert_eq!(
                s.subfolder.as_deref(),
                Some("nemotron-3.5-asr-streaming-0.6b-onnx")
            );
            assert!(s.dest_dir.ends_with("nemotron-3.5-streaming-onnx"));
        }
    }

    #[test]
    fn backend_kind_serializes_kebab_case() {
        assert_eq!(
            serde_yaml::to_string(&BackendKind::ParakeetNemotron).unwrap(),
            "parakeet-nemotron\n"
        );
        assert_eq!(
            serde_yaml::to_string(&BackendKind::WhisperGgml).unwrap(),
            "whisper-ggml\n"
        );
    }

    #[test]
    fn parakeet_lenient_resolves_strict_requires_artifacts() {
        // Lenient resolve returns the spec (bin_path = artifact DIR) even
        // with nothing on disk; strict resolve requires all four ONNX
        // artifact files to exist.
        let base = std::env::temp_dir().join("ww-registry-parakeet-resolve-test");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&base);
        let reg_path = base.join("models.yaml");
        std::fs::write(&reg_path, SAMPLE).unwrap();

        let mut config = Config::from_env();
        config.registry_path = reg_path;
        config.models_dir = base.join("models");
        config.model_dir = None;

        let m = resolve_named_model_lenient(&config, "parakeet-tdt-0.6b").unwrap();
        assert_eq!(m.backend, BackendKind::ParakeetNemotron);
        assert_eq!(m.format, "onnx");
        assert!(m.bin_path.ends_with("parakeet-tdt-0.6b-onnx"));
        assert_eq!(m.quant, None);
        assert!(m.coreml_encoder.is_none());

        // Strict: fails while any of the four artifact files is missing.
        assert!(matches!(
            resolve_named_model(&config, "parakeet-tdt-0.6b"),
            Err(RegistryError::ModelFileMissing(_))
        ));

        // Create three of four — still missing.
        let dir = config.models_dir.join("parakeet-tdt-0.6b-onnx");
        std::fs::create_dir_all(&dir).unwrap();
        for f in ["encoder.onnx", "encoder.onnx.data", "decoder_joint.onnx"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        assert!(matches!(
            resolve_named_model(&config, "parakeet-tdt-0.6b"),
            Err(RegistryError::ModelFileMissing(_))
        ));

        // All four present — strict resolve succeeds.
        std::fs::write(dir.join("tokenizer.model"), b"x").unwrap();
        let m = resolve_named_model(&config, "parakeet-tdt-0.6b").unwrap();
        assert_eq!(m.backend, BackendKind::ParakeetNemotron);

        let _ = std::fs::remove_dir_all(&base);
    }
}
