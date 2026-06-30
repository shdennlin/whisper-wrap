//! Env-driven configuration. Port of `app/config.py` (beta.1 subset:
//! the /transcribe + /status path). Invalid values WARN and fall back
//! to defaults, matching the Python `_parse_*` helpers.

use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub api_port: u16,
    pub api_host: String,
    /// Optional per-launch bearer token. When set (the desktop sets it when it
    /// spawns the engine as a sidecar), the router rejects API requests that do
    /// not present `Authorization: Bearer <token>`. Unset (self-host / web) →
    /// no gate. `/`, `/status`, and `/app/*` stay open regardless.
    pub engine_token: Option<String>,
    pub model_name: String,
    pub model_dir: Option<PathBuf>,
    pub models_dir: PathBuf,
    pub registry_path: PathBuf,
    pub max_file_size_mb: u64,
    pub temp_dir: PathBuf,
    pub upload_timeout_seconds: u64,
    pub filter_empty_enabled: bool,
    pub filter_min_duration_ms: u64,
    /// Raw values — `None` (unset) vs `Some("")` (set-but-empty) is
    /// significant for the warn-vs-silent default policy in llm.py.
    pub gemini_api_key: Option<String>,
    pub gemini_model: Option<String>,
    pub gemini_system_prompt: Option<String>,
    /// LLM provider selection (llm-provider-abstraction). `LLM_PROVIDER`
    /// defaults to "gemini" (reads the GEMINI_* vars above); "openai" uses an
    /// OpenAI-compatible endpoint via the LLM_* vars below.
    pub llm_provider: Option<String>,
    pub llm_base_url: Option<String>,
    pub llm_api_key: Option<String>,
    pub llm_model: Option<String>,
    pub actions_path: PathBuf,
    pub meeting_job_ttl_seconds: u64,
    pub meeting_max_jobs: usize,
    /// Diarization ONNX models. Defaults live under
    /// `<models_dir>/diarization/`; both must exist or the meeting
    /// endpoints answer 503 (the v2 availability-gate pattern).
    pub data_dir: PathBuf,
    pub vad_backend: Option<String>,
    pub silero_vad_model: PathBuf,
    pub diarize_seg_model: PathBuf,
    pub diarize_emb_model: PathBuf,
    /// Larger speaker-embedding model for the meeting "Balanced" quality
    /// tier (3D-Speaker ERes2NetV2). Optional install — the tier is
    /// offered only when this file exists.
    pub diarize_emb_model_balanced: PathBuf,
}

fn parse_bool(raw: Option<String>, default: bool, var_name: &str) -> bool {
    match raw.as_deref().map(str::trim) {
        None | Some("") => default,
        Some(v) if v.eq_ignore_ascii_case("true") => true,
        Some(v) if v.eq_ignore_ascii_case("false") => false,
        Some(v) => {
            log::warn!("Invalid value for {var_name}={v:?}; using default {default:?}");
            default
        }
    }
}

fn parse_u64(raw: Option<String>, default: u64, var_name: &str) -> u64 {
    match raw.as_deref().map(str::trim) {
        None | Some("") => default,
        Some(v) => v.parse().unwrap_or_else(|_| {
            log::warn!("Invalid value for {var_name}={v:?}; using default {default:?}");
            default
        }),
    }
}

fn non_empty(raw: Option<String>) -> Option<String> {
    raw.filter(|s| !s.is_empty())
}

impl Config {
    pub fn from_env() -> Self {
        let var = |k: &str| env::var(k).ok();
        Config {
            api_port: parse_u64(var("API_PORT"), 8000, "API_PORT") as u16,
            api_host: var("API_HOST").unwrap_or_else(|| "0.0.0.0".into()),
            engine_token: non_empty(var("ENGINE_TOKEN")),
            model_name: non_empty(var("MODEL_NAME")).unwrap_or_else(|| "breeze-asr-25".into()),
            model_dir: non_empty(var("MODEL_DIR")).map(PathBuf::from),
            models_dir: PathBuf::from(var("MODELS_DIR").unwrap_or_else(|| "models".into())),
            registry_path: PathBuf::from(
                var("REGISTRY_PATH").unwrap_or_else(|| "registry/models.yaml".into()),
            ),
            max_file_size_mb: parse_u64(var("MAX_FILE_SIZE_MB"), 100, "MAX_FILE_SIZE_MB"),
            temp_dir: PathBuf::from(var("TEMP_DIR").unwrap_or_else(|| "/tmp/whisper-wrap".into())),
            upload_timeout_seconds: parse_u64(
                var("UPLOAD_TIMEOUT_SECONDS"),
                30,
                "UPLOAD_TIMEOUT_SECONDS",
            ),
            filter_empty_enabled: parse_bool(
                var("FILTER_EMPTY_ENABLED"),
                true,
                "FILTER_EMPTY_ENABLED",
            ),
            filter_min_duration_ms: parse_u64(
                var("FILTER_MIN_DURATION_MS"),
                500,
                "FILTER_MIN_DURATION_MS",
            ),
            gemini_api_key: var("GEMINI_API_KEY"),
            gemini_model: var("GEMINI_MODEL"),
            gemini_system_prompt: var("GEMINI_SYSTEM_PROMPT"),
            llm_provider: var("LLM_PROVIDER"),
            llm_base_url: var("LLM_BASE_URL"),
            llm_api_key: var("LLM_API_KEY"),
            llm_model: var("LLM_MODEL"),
            actions_path: PathBuf::from(
                var("ACTIONS_PATH").unwrap_or_else(|| "registry/actions.yaml".into()),
            ),
            meeting_job_ttl_seconds: parse_u64(
                var("MEETING_JOB_TTL_SECONDS"),
                3600,
                "MEETING_JOB_TTL_SECONDS",
            ),
            meeting_max_jobs: parse_u64(var("MEETING_MAX_JOBS"), 20, "MEETING_MAX_JOBS") as usize,
            data_dir: PathBuf::from(var("DATA_DIR").unwrap_or_else(|| "data".into())),
            vad_backend: non_empty(var("VAD_BACKEND")),
            silero_vad_model: var("SILERO_VAD_MODEL")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(var("MODELS_DIR").unwrap_or_else(|| "models".into()))
                        .join("diarization/silero_vad.onnx")
                }),
            diarize_seg_model: var("DIARIZE_SEG_MODEL")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(var("MODELS_DIR").unwrap_or_else(|| "models".into()))
                        .join("diarization/segmentation.onnx")
                }),
            diarize_emb_model: var("DIARIZE_EMB_MODEL")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(var("MODELS_DIR").unwrap_or_else(|| "models".into()))
                        .join("diarization/embedding.onnx")
                }),
            diarize_emb_model_balanced: var("DIARIZE_EMB_MODEL_BALANCED")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(var("MODELS_DIR").unwrap_or_else(|| "models".into()))
                        .join("diarization/embedding-balanced.onnx")
                }),
        }
    }

    pub fn max_file_size_bytes(&self) -> u64 {
        self.max_file_size_mb * 1024 * 1024
    }

    pub fn ensure_temp_dir(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.temp_dir)
    }

    pub fn audio_dir(&self) -> PathBuf {
        self.data_dir.join("audio")
    }

    pub fn ensure_data_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(self.audio_dir())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bool_parsing_matches_python_semantics() {
        assert!(parse_bool(None, true, "X"));
        assert!(!parse_bool(Some("false".into()), true, "X"));
        assert!(parse_bool(Some("TRUE".into()), false, "X"));
        assert!(parse_bool(Some("".into()), true, "X"));
        assert!(parse_bool(Some("yes".into()), true, "X")); // invalid → default
    }

    #[test]
    fn u64_parsing_falls_back_on_garbage() {
        assert_eq!(parse_u64(Some("abc".into()), 500, "X"), 500);
        assert_eq!(parse_u64(Some("250".into()), 500, "X"), 250);
        assert_eq!(parse_u64(None, 500, "X"), 500);
    }
}
