//! Persisted active-ASR-model selection.
//!
//! `ModelConfigStore` owns `data/model_config.json` so the model picked via
//! `POST /models/active` survives a restart. Boot resolution is
//! **stored-file > `MODEL_NAME` env > default** — the same precedence
//! `AiConfigStore` uses (D1) — with one carve-out: an explicit `MODEL_DIR`
//! override is a power-user pointer at a real directory and stays
//! authoritative. Degradation follows the sibling stores: missing file →
//! fall through, malformed file → warn + fall through, failed write → error
//! log while the in-memory swap stays effective for the running process.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use whisper_wrap_core::{registry, Config};

/// The on-disk JSON document. `active_model` is optional so an empty or
/// partial file falls through to env/default instead of erroring.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StoredModelConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    active_model: Option<String>,
}

/// Owns the JSON file. Stateless between calls — the file is the source of
/// truth (AiConfigStore semantics; this is boot/activation-path only, never
/// the transcription hot path).
pub struct ModelConfigStore {
    path: PathBuf,
}

impl ModelConfigStore {
    /// The JSON lives at `<data_dir>/model_config.json`.
    pub fn new(data_dir: &Path) -> Self {
        ModelConfigStore {
            path: data_dir.join("model_config.json"),
        }
    }

    /// The persisted selection, if any. Missing file → `None`; malformed
    /// JSON → warning + `None` (never crashes boot).
    pub fn load_active(&self) -> Option<String> {
        let raw = std::fs::read_to_string(&self.path).ok()?;
        match serde_json::from_str::<StoredModelConfig>(&raw) {
            Ok(cfg) => cfg.active_model.filter(|n| !n.is_empty()),
            Err(e) => {
                log::warn!(
                    "malformed {}: {e} — falling back to the environment model",
                    self.path.display()
                );
                None
            }
        }
    }

    /// Persist a successful activation. A failed disk write is logged but
    /// does NOT roll back the hot-swap: the selection stays effective until
    /// restart (AiConfigStore semantics).
    pub fn save_active(&self, name: &str) {
        let cfg = StoredModelConfig {
            active_model: Some(name.to_owned()),
        };
        if let Err(e) = self.write(&cfg) {
            log::error!("failed to persist {}: {e}", self.path.display());
        }
    }

    /// Boot-time active-model name: the persisted selection when it still
    /// resolves in the registry (leniently — absent weights are the normal
    /// first-run state), else the env/default `config.model_name`. An
    /// explicit `MODEL_DIR` override wins outright.
    pub fn resolve_model_name(&self, config: &Config) -> String {
        if config.model_dir.is_some() {
            return config.model_name.clone();
        }
        let Some(stored) = self.load_active() else {
            return config.model_name.clone();
        };
        match registry::resolve_named_model_lenient(config, &stored) {
            Ok(_) => stored,
            Err(e) => {
                log::warn!(
                    "persisted active model {stored:?} no longer resolves ({e}) — \
                     falling back to {:?}",
                    config.model_name
                );
                config.model_name.clone()
            }
        }
    }

    fn write(&self, cfg: &StoredModelConfig) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_string_pretty(cfg).map_err(std::io::Error::other)?;
        std::fs::write(&self.path, body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(test: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ww-model-config-{}-{test}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create sandbox");
        dir
    }

    #[test]
    fn save_then_load_round_trips() {
        let store = ModelConfigStore::new(&sandbox("roundtrip"));
        assert_eq!(store.load_active(), None, "fresh dir has no selection");
        store.save_active("whisper-small-test");
        assert_eq!(store.load_active(), Some("whisper-small-test".into()));
        store.save_active("breeze-asr-25");
        assert_eq!(store.load_active(), Some("breeze-asr-25".into()));
    }

    #[test]
    fn malformed_file_loads_as_none() {
        let dir = sandbox("malformed");
        std::fs::write(dir.join("model_config.json"), b"{ not json").expect("seed");
        assert_eq!(ModelConfigStore::new(&dir).load_active(), None);
    }

    #[test]
    fn empty_or_absent_field_loads_as_none() {
        let dir = sandbox("empty-field");
        std::fs::write(dir.join("model_config.json"), b"{}").expect("seed");
        assert_eq!(ModelConfigStore::new(&dir).load_active(), None);
        std::fs::write(dir.join("model_config.json"), br#"{ "active_model": "" }"#).expect("seed");
        assert_eq!(ModelConfigStore::new(&dir).load_active(), None);
    }
}
