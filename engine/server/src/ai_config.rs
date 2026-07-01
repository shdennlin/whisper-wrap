//! Persisted AI configuration (ai-provider-settings).
//!
//! `AiConfigStore` owns `data/llm_config.json` and the env-snapshot `Config`.
//! It resolves the active config as **stored-file > env > default** (D1),
//! builds the live `LlmClient` (D2), masks the key on read (D4), and serves the
//! four `/config/ai` endpoints (D3). The raw key is NEVER logged and NEVER
//! returned by a read.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use whisper_wrap_core::Config;

use crate::llm::{self, LlmClient};
use crate::routes::ApiError;
use crate::state::AppState;

const VALID_PROVIDERS: [&str; 2] = ["gemini", "openai-compatible"];

/// The on-disk JSON document. All fields optional so a partial file overlays
/// only what it sets (missing fields fall through to env/default).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StoredConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_prompt: Option<String>,
}

/// The masked, read-safe view of the active config. Wire shape is camelCase.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct AiConfigView {
    pub provider: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub model: String,
    #[serde(rename = "keySet")]
    pub key_set: bool,
    #[serde(rename = "keyHint")]
    pub key_hint: String,
    #[serde(rename = "systemPromptSet")]
    pub system_prompt_set: bool,
}

/// Update body for `PUT /config/ai`. camelCase on the wire.
#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
pub struct AiConfigUpdate {
    pub provider: String,
    #[serde(rename = "baseUrl", default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(rename = "apiKey", default)]
    pub api_key: String,
    #[serde(rename = "systemPrompt", default)]
    pub system_prompt: Option<String>,
}

/// Owns the JSON file and the env baseline. `resolve()` re-reads the file each
/// call so the file is always the source of truth (no in-memory cache to keep
/// coherent across saves).
pub struct AiConfigStore {
    path: PathBuf,
    base: Config,
}

impl AiConfigStore {
    /// `base` is the env-snapshot config; the JSON lives at `base.data_dir/llm_config.json`.
    pub fn new(base: Config) -> Self {
        let path = base.data_dir.join("llm_config.json");
        AiConfigStore { path, base }
    }

    /// Load the stored document. Missing file -> default (all-None). Malformed
    /// JSON -> a warning + default (never panics, never crashes boot).
    fn load(&self) -> StoredConfig {
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(s) => s,
            Err(_) => return StoredConfig::default(),
        };
        match serde_json::from_str::<StoredConfig>(&raw) {
            Ok(cfg) => cfg,
            Err(e) => {
                log::warn!(
                    "malformed {}: {e} — falling back to environment config",
                    self.path.display()
                );
                StoredConfig::default()
            }
        }
    }

    /// Active config: overlay stored-file over env over built-in default (D1).
    pub fn resolve(&self) -> Config {
        let stored = self.load();
        overlay(self.base.clone(), &stored)
    }

    /// Build the live client from the resolved config.
    pub fn build_client(&self) -> LlmClient {
        LlmClient::from_config(&self.resolve())
    }

    /// The masked, read-safe view. Never exposes the raw key.
    pub fn read_masked(&self) -> AiConfigView {
        let resolved = self.resolve();
        view_from(&resolved)
    }

    /// Persist an update and return the masked view. Empty `apiKey` keeps the
    /// stored key; a non-empty value replaces it (D4). Writes the file `0600`.
    /// The key is never logged.
    pub fn save(&self, update: serde_json::Value) -> AiConfigView {
        let update: AiConfigUpdate =
            serde_json::from_value(update).unwrap_or_else(|_| AiConfigUpdate {
                provider: "gemini".into(),
                base_url: String::new(),
                model: String::new(),
                api_key: String::new(),
                system_prompt: None,
            });
        let prior = self.load();
        let api_key = if update.api_key.is_empty() {
            prior.api_key.clone()
        } else {
            Some(update.api_key.clone())
        };
        let next = StoredConfig {
            provider: Some(update.provider.clone()),
            base_url: Some(update.base_url.clone()),
            model: Some(update.model.clone()),
            api_key,
            system_prompt: update.system_prompt.clone().or(prior.system_prompt),
        };
        if let Err(e) = self.write(&next) {
            // Surface as a log; the resolved view below still reflects intent
            // when the write fails, but log so the operator notices.
            log::error!("failed to persist {}: {e}", self.path.display());
        }
        view_from(&overlay(self.base.clone(), &next))
    }

    fn write(&self, cfg: &StoredConfig) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_string_pretty(cfg).map_err(std::io::Error::other)?;
        // Create the file 0600 atomically so the plaintext key never exists
        // world-readable, even briefly on first write (chmod-after-write would
        // leave a TOCTOU window under the default umask).
        write_owner_only(&self.path, body.as_bytes())?;
        // Belt-and-suspenders: tighten perms if the file pre-existed with
        // looser permissions (create+truncate keeps the old mode).
        set_owner_only(&self.path)?;
        Ok(())
    }

    /// `keyHint`: first 4 + `…` + last 4 of the key (D4). Short keys degrade
    /// gracefully (no panic, no full-secret leak). Operates on chars so a
    /// non-ASCII key cannot split a UTF-8 boundary.
    pub fn mask(key: &str) -> String {
        let chars: Vec<char> = key.chars().collect();
        if chars.is_empty() {
            return "•".into();
        }
        if chars.len() <= 8 {
            // Too short to show a head+tail without revealing most of it.
            return "•".repeat(chars.len().min(8));
        }
        let head: String = chars[..4].iter().collect();
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("{head}…{tail}")
    }
}

#[cfg(unix)]
fn set_owner_only(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &std::path::Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn write_owner_only(path: &std::path::Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(body)
}

#[cfg(not(unix))]
fn write_owner_only(path: &std::path::Path, body: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, body)
}

/// Overlay a stored document onto a base `Config`. Provider-specific fields are
/// mapped to the matching `Config` slots so `LlmClient::from_config` sees them.
fn overlay(mut base: Config, stored: &StoredConfig) -> Config {
    if let Some(provider) = &stored.provider {
        base.llm_provider = Some(provider.clone());
    }
    let provider = base.llm_provider.clone().unwrap_or_default();
    let is_gemini = provider != "openai" && provider != "openai-compatible";
    if is_gemini {
        if let Some(m) = stored.model.clone() {
            base.gemini_model = Some(m);
        }
        if let Some(k) = stored.api_key.clone() {
            base.gemini_api_key = Some(k);
        }
    } else {
        if let Some(u) = stored.base_url.clone() {
            base.llm_base_url = Some(u);
        }
        if let Some(m) = stored.model.clone() {
            base.llm_model = Some(m);
        }
        if let Some(k) = stored.api_key.clone() {
            base.llm_api_key = Some(k);
        }
    }
    // Both providers read the system prompt from gemini_system_prompt.
    if let Some(sp) = stored.system_prompt.clone() {
        base.gemini_system_prompt = Some(sp);
    }
    base
}

/// Build the masked view from a resolved `Config`, reading the active provider's
/// key/model/endpoint via a transient client (so the view always matches what
/// `/ask` would use).
fn view_from(resolved: &Config) -> AiConfigView {
    let client = LlmClient::from_config(resolved);
    let provider = client.provider_name().to_owned();
    let is_gemini = provider == "gemini";
    let raw_key = if is_gemini {
        resolved.gemini_api_key.clone()
    } else {
        resolved.llm_api_key.clone()
    }
    .filter(|k| !k.is_empty());
    let base_url = if is_gemini {
        String::new()
    } else {
        client.endpoint().to_owned()
    };
    AiConfigView {
        provider,
        base_url,
        model: client.model().to_owned(),
        key_set: raw_key.is_some(),
        key_hint: raw_key.as_deref().map(AiConfigStore::mask).unwrap_or_default(),
        system_prompt_set: resolved
            .gemini_system_prompt
            .as_deref()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
    }
}

// ---------- HTTP handlers ----------

/// `GET /config/ai` — masked read of the active config.
#[utoipa::path(
    get,
    path = "/config/ai",
    tag = "ai-config",
    responses((status = 200, description = "The masked, read-safe AI provider config.", body = AiConfigView))
)]
pub async fn get_config(State(state): State<Arc<AppState>>) -> Json<AiConfigView> {
    Json(state.ai_config.read_masked())
}

/// `PUT /config/ai` — validate, save, swap the live client, return the masked
/// view. Invalid provider -> 400. Empty `apiKey` keeps the stored key.
#[utoipa::path(
    put,
    path = "/config/ai",
    tag = "ai-config",
    request_body(content = AiConfigUpdate, description = "Partial AI provider config update (camelCase). Unknown keys are ignored; the runtime accepts a lenient JSON object."),
    responses(
        (status = 200, description = "The updated masked config.", body = AiConfigView),
        (status = 400, description = "Malformed or invalid config body.", body = crate::routes::ApiErrorBody)
    )
)]
pub async fn put_config(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<AiConfigView>, ApiError> {
    let provider = body
        .get("provider")
        .and_then(|p| p.as_str())
        .unwrap_or_default();
    if !VALID_PROVIDERS.contains(&provider) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid provider {provider:?}; expected one of {VALID_PROVIDERS:?}"),
        ));
    }
    // openai-compatible carries a user-supplied base URL that the server will
    // later call from /ask; reject SSRF-prone targets before persisting so the
    // saved config can never point /ask at a blocked host.
    if provider == "openai-compatible" {
        let base = body
            .get("baseUrl")
            .and_then(|b| b.as_str())
            .unwrap_or_default()
            .trim_end_matches('/');
        if !base.is_empty() {
            if let Err(e) = llm::validate_outbound_url(base).await {
                return Err(ApiError::new(StatusCode::BAD_REQUEST, e));
            }
        }
    }
    let view = state.ai_config.save(body);
    // Hot-swap (D2): rebuild from the freshly written file and install it.
    state.swap_llm(state.ai_config.build_client());
    Ok(Json(view))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ModelsQuery {
    #[serde(default)]
    provider: String,
    #[serde(rename = "baseUrl", default)]
    base_url: String,
    #[serde(rename = "apiKey", default)]
    api_key: String,
}

/// `GET /config/ai/models` — list provider models using the SUBMITTED
/// provider/base-url/key. Any fetch failure -> 200 with `models: []` + a
/// non-null `error` (never a 5xx).
#[utoipa::path(
    get,
    path = "/config/ai/models",
    tag = "ai-config",
    params(ModelsQuery),
    responses((status = 200, description = "Available models for the given provider/baseUrl/apiKey, or an error descriptor embedded in the JSON."))
)]
pub async fn list_models(Query(q): Query<ModelsQuery>) -> Json<serde_json::Value> {
    match llm::list_models(&q.provider, &q.base_url, &q.api_key).await {
        Ok(models) => Json(json!({ "models": models, "error": serde_json::Value::Null })),
        Err(e) => Json(json!({ "models": [], "error": e })),
    }
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct TestBody {
    #[serde(default)]
    provider: String,
    #[serde(rename = "baseUrl", default)]
    base_url: String,
    #[serde(default)]
    model: String,
    #[serde(rename = "apiKey", default)]
    api_key: String,
}

/// Connectivity-test result for `POST /config/ai/test`. Wire shape is
/// `{ "ok": bool, "error": string | null }`: `error` is always present and is
/// `null` on success, so it is a plain `Option<String>` (emitted as `null`, not
/// omitted) to match today's `json!()` output byte-for-byte.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct AiTestResult {
    pub ok: bool,
    pub error: Option<String>,
}

/// `POST /config/ai/test` — build a transient client from the submitted body,
/// do one minimal non-streaming `ask`, report `{ ok, error }`. Never persists.
#[utoipa::path(
    post,
    path = "/config/ai/test",
    tag = "ai-config",
    request_body(content = TestBody, description = "Provider credentials/settings to test-connect against."),
    responses((status = 200, description = "Connectivity test result `{ok, error}` (failures are reported in the body, not as a non-200 status).", body = AiTestResult))
)]
pub async fn test_config(Json(body): Json<TestBody>) -> Json<AiTestResult> {
    let mut config = Config::from_env();
    config.llm_provider = Some(if body.provider == "openai" {
        "openai-compatible".into()
    } else {
        body.provider.clone()
    });
    let is_gemini = body.provider == "gemini";
    if is_gemini {
        config.gemini_model = Some(body.model.clone()).filter(|m| !m.is_empty());
        config.gemini_api_key = Some(body.api_key.clone()).filter(|k| !k.is_empty());
    } else {
        let base = body.base_url.trim_end_matches('/');
        if !base.is_empty() {
            if let Err(e) = llm::validate_outbound_url(base).await {
                return Json(AiTestResult { ok: false, error: Some(e) });
            }
        }
        config.llm_base_url = Some(body.base_url.clone()).filter(|u| !u.is_empty());
        config.llm_model = Some(body.model.clone()).filter(|m| !m.is_empty());
        config.llm_api_key = Some(body.api_key.clone()).filter(|k| !k.is_empty());
    }
    let client = LlmClient::from_config(&config);
    match client.ask("ping", None).await {
        Ok(_) => Json(AiTestResult { ok: true, error: None }),
        Err(e) => Json(AiTestResult { ok: false, error: Some(e.to_string()) }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pins the `POST /config/ai/test` wire shape: `AiTestResult` must serialize
    // byte-for-byte to the `json!()` the handler produced before it was typed.
    #[test]
    fn ai_test_result_success_matches_wire_shape() {
        let got = serde_json::to_value(AiTestResult { ok: true, error: None }).unwrap();
        // Success path emitted `{ "ok": true, "error": null }` — `error` is
        // present as null, not omitted.
        let expected = json!({ "ok": true, "error": serde_json::Value::Null });
        assert_eq!(got, expected);
    }

    #[test]
    fn ai_test_result_error_matches_wire_shape() {
        let got = serde_json::to_value(AiTestResult {
            ok: false,
            error: Some("boom".to_string()),
        })
        .unwrap();
        // Error path emitted `{ "ok": false, "error": "<message>" }`.
        let expected = json!({ "ok": false, "error": "boom" });
        assert_eq!(got, expected);
    }
}
