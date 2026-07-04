//! Persisted transcript dictionary config (zh-convert-dictionary).
//!
//! `DictionaryConfigStore` owns `data/dictionary_config.json`: the zh
//! conversion mode plus the ordered word-replacement table, served by the two
//! `/config/dictionary` endpoints. Follows the `AiConfigStore` degradation
//! semantics — missing file → defaults, malformed file → warn + defaults, a
//! failed write → error log while the accepted config stays effective in
//! memory for the running process. Unlike `AiConfigStore` there is no env
//! baseline (no env vars feed this surface) and the document is held in
//! memory behind an `RwLock`: the transcription hot path reads it per request
//! and must not pay a file read + parse each time.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Json;
use serde::{Deserialize, Serialize};

use crate::routes::ApiError;
use crate::state::AppState;

/// Validation cap on the replacement table (spec: 1001 pairs → 400).
pub const MAX_REPLACEMENTS: usize = 1000;

/// The conversion mode. `s2twp` is deliberately not offered — phrase-level
/// localization would rewrite words the speaker never said (design Non-Goal).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ZhConvertSetting {
    #[default]
    Off,
    S2tw,
}

/// One ordered replacement pair. `from` matches ASCII-case-insensitively;
/// `to` is inserted exactly as authored (see `whisper_wrap_core::replace`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ReplacementPair {
    #[schema(example = "Cloud Code")]
    pub from: String,
    #[schema(example = "Claude Code")]
    pub to: String,
}

/// The on-disk document AND the wire shape of both endpoints (they are
/// identical by design — no secrets to mask here).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct DictionaryConfig {
    #[serde(default)]
    pub zh_convert: ZhConvertSetting,
    #[serde(default)]
    pub replacements: Vec<ReplacementPair>,
}

/// Owns the JSON file and the in-memory current document.
pub struct DictionaryConfigStore {
    path: PathBuf,
    current: RwLock<DictionaryConfig>,
}

impl DictionaryConfigStore {
    /// Load (or default) from `<data_dir>/dictionary_config.json`.
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("dictionary_config.json");
        let current = RwLock::new(load(&path));
        DictionaryConfigStore { path, current }
    }

    /// The current effective config (cheap clone; rules are small by cap).
    pub fn get(&self) -> DictionaryConfig {
        self.current.read().expect("dictionary lock").clone()
    }

    /// Install a validated config and persist it. A failed disk write is
    /// logged but does NOT roll back the in-memory state: the accepted
    /// config stays effective until restart (AiConfigStore semantics).
    pub fn save(&self, cfg: DictionaryConfig) {
        *self.current.write().expect("dictionary lock") = cfg.clone();
        if let Err(e) = write(&self.path, &cfg) {
            log::error!("failed to persist {}: {e}", self.path.display());
        }
    }

    /// The shared transcript apply step (spec: Pipeline position). Every
    /// transcript-producing path calls this on text that survived the
    /// empty-transcription filter, before returning or persisting it.
    pub fn apply(&self, text: &str) -> String {
        apply_config(text, &self.get())
    }
}

/// Fixed pipeline order: zh conversion first, then word replacements — so
/// rules are authored once, in Traditional script only.
pub fn apply_config(text: &str, cfg: &DictionaryConfig) -> String {
    let mode = match cfg.zh_convert {
        ZhConvertSetting::Off => whisper_wrap_core::zh_convert::ZhConvertMode::Off,
        ZhConvertSetting::S2tw => whisper_wrap_core::zh_convert::ZhConvertMode::S2tw,
    };
    let converted = whisper_wrap_core::zh_convert::convert(text, mode);
    if cfg.replacements.is_empty() {
        return converted;
    }
    let rules: Vec<whisper_wrap_core::replace::ReplaceRule> = cfg
        .replacements
        .iter()
        .map(|p| whisper_wrap_core::replace::ReplaceRule {
            from: p.from.clone(),
            to: p.to.clone(),
        })
        .collect();
    whisper_wrap_core::replace::apply(&converted, &rules)
}

/// Missing file → defaults. Malformed JSON → warning + defaults (never
/// crashes boot).
fn load(path: &Path) -> DictionaryConfig {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return DictionaryConfig::default(),
    };
    match serde_json::from_str::<DictionaryConfig>(&raw) {
        Ok(cfg) => cfg,
        Err(e) => {
            log::warn!(
                "malformed {}: {e} — falling back to dictionary defaults",
                path.display()
            );
            DictionaryConfig::default()
        }
    }
}

fn write(path: &Path, cfg: &DictionaryConfig) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(cfg).map_err(std::io::Error::other)?;
    std::fs::write(path, body)
}

/// Validate a raw PUT body into a typed config. String errors become the 400
/// `detail`. Missing fields default (off / empty table) so a partial body is
/// a valid full document.
fn validate(value: &serde_json::Value) -> Result<DictionaryConfig, String> {
    let zh_convert = match value.get("zh_convert") {
        None | Some(serde_json::Value::Null) => ZhConvertSetting::Off,
        Some(serde_json::Value::String(s)) if s == "off" => ZhConvertSetting::Off,
        Some(serde_json::Value::String(s)) if s == "s2tw" => ZhConvertSetting::S2tw,
        Some(other) => {
            return Err(format!(
                "invalid zh_convert {other}; expected \"off\" or \"s2tw\""
            ))
        }
    };
    let replacements = match value.get("replacements") {
        None | Some(serde_json::Value::Null) => vec![],
        Some(serde_json::Value::Array(items)) => {
            if items.len() > MAX_REPLACEMENTS {
                return Err(format!(
                    "too many replacements ({}); the table is capped at {MAX_REPLACEMENTS}",
                    items.len()
                ));
            }
            let mut rules = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                let pair: ReplacementPair = serde_json::from_value(item.clone())
                    .map_err(|e| format!("replacements[{i}] is not a {{from, to}} pair: {e}"))?;
                if pair.from.trim().is_empty() {
                    return Err(format!(
                        "replacements[{i}].from must be non-empty after trimming"
                    ));
                }
                rules.push(pair);
            }
            rules
        }
        Some(other) => return Err(format!("replacements must be an array, got {other}")),
    };
    Ok(DictionaryConfig {
        zh_convert,
        replacements,
    })
}

// ---------- HTTP handlers ----------

/// `GET /config/dictionary` — the current effective dictionary config.
#[utoipa::path(
    get,
    path = "/config/dictionary",
    tag = "dictionary-config",
    responses((status = 200, description = "The effective dictionary config (conversion mode + replacement table).", body = DictionaryConfig))
)]
pub async fn get_dictionary(State(state): State<Arc<AppState>>) -> Json<DictionaryConfig> {
    Json(state.dictionary.get())
}

/// `PUT /config/dictionary` — validate, persist, return the stored config.
#[utoipa::path(
    put,
    path = "/config/dictionary",
    tag = "dictionary-config",
    request_body(content = DictionaryConfig, description = "Full dictionary config document. Missing fields default (off / empty table)."),
    responses(
        (status = 200, description = "The stored dictionary config.", body = DictionaryConfig),
        (status = 400, description = "Invalid mode, empty `from`, or table over the cap.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn put_dictionary(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<DictionaryConfig>, ApiError> {
    let cfg = validate(&body).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;
    state.dictionary.save(cfg.clone());
    Ok(Json(cfg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Pins the wire shape of the serde enum: lowercase strings, defaulting Off.
    #[test]
    fn zh_convert_setting_serializes_lowercase() {
        assert_eq!(
            serde_json::to_value(ZhConvertSetting::Off).unwrap(),
            json!("off")
        );
        assert_eq!(
            serde_json::to_value(ZhConvertSetting::S2tw).unwrap(),
            json!("s2tw")
        );
    }

    #[test]
    fn validate_defaults_missing_fields() {
        let cfg = validate(&json!({})).unwrap();
        assert_eq!(cfg, DictionaryConfig::default());
    }

    // The spec's pipeline-position example: conversion runs BEFORE the
    // replacement table, so a Traditional-script rule matches converted
    // output — 云端 converts to 雲端, then the rule 雲端→雲端硬碟 applies.
    #[test]
    fn apply_converts_before_replacing() {
        let cfg: DictionaryConfig = serde_json::from_value(json!({
            "zh_convert": "s2tw",
            "replacements": [ { "from": "雲端", "to": "雲端硬碟" } ]
        }))
        .unwrap();
        assert_eq!(apply_config("云端", &cfg), "雲端硬碟");
    }

    #[test]
    fn apply_default_config_is_identity() {
        assert_eq!(
            apply_config("简体 cloud code", &DictionaryConfig::default()),
            "简体 cloud code"
        );
    }
}
